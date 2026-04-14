import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { EngramCore } from '../service.js';
import { createEngramCore } from '../service.js';
import * as svc from '../service.js';
import { metrics, renderMetrics, startTimer } from '../metrics.js';
import { log, newRequestId } from '../logger.js';
import { RateLimiter, type RateLimitConfig } from '../rate-limit.js';

const VALID_EVENT_TYPES = ['observation', 'action', 'mutation', 'query', 'system'] as const;

const contextBodySchema = z.object({
  topic: z.string().max(1000).optional(),
  entities: z.array(z.string().max(512)).max(20).optional(),
  max_tokens: z.number().min(100).max(8000).optional(),
  strategy: z.enum(['graph', 'semantic', 'hybrid']).optional(),
});

function safeInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function validateNamespace(ns: string): boolean {
  return /^[a-zA-Z0-9_\-.]+$/.test(ns) && ns.length >= 1 && ns.length <= 64;
}

/**
 * Resolve rate-limiter key. Priority:
 * 1. Bearer token fingerprint (SHA-256 truncated) — H-B4 fix, no prefix collisions
 * 2. X-Forwarded-For first hop (only when ENGRAM_TRUST_PROXY=1)
 * 3. Socket remote address via Hono conninfo
 * 4. 'anon' fallback
 */
async function resolveClientKey(
  c: any,
  trustProxy: boolean,
  getConnInfo: (c: any) => { remote?: { address?: string; port?: number } },
): Promise<string> {
  const authHeader = c.req.header('authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const hash = createHash('sha256').update(token).digest('hex').slice(0, 16);
    return `token:${hash}`;
  }

  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return `ip:${fwd}`;
  }

  try {
    const info = getConnInfo(c);
    if (info.remote?.address) return `ip:${info.remote.address}`;
  } catch {
    // conninfo not wired — fall through
  }
  return 'anon';
}

/** Normalize /api/nodes/01HXYZ to /api/nodes/:id for metric cardinality */
function normalizePath(path: string): string {
  return path
    .replace(/\/api\/nodes\/[^/]+/, '/api/nodes/:id')
    .replace(/\/api\/edges\/[^/]+/, '/api/edges/:nodeId')
    .replace(/\/api\/history\/[^/]+/, '/api/history/:nodeId');
}

export interface ApiOptions {
  /** If true, allow ?namespace= or X-Engram-Namespace header to override default core */
  allowPerRequestNamespace?: boolean;
  /** Rate limit config (overrides env). Set to `false` to disable. */
  rateLimit?: RateLimitConfig | false;
  /**
   * Bearer token(s) required for API access.
   * - Single string: that token must match
   * - Array: any matching token is allowed
   * - undefined: reads ENGRAM_API_TOKEN env (comma-separated); unset → auth disabled
   */
  authTokens?: string | string[];
}

/** Build token set from option or env var */
function resolveAuthTokens(opt?: string | string[]): Set<string> {
  if (Array.isArray(opt)) return new Set(opt.filter(Boolean));
  if (typeof opt === 'string') return new Set([opt].filter(Boolean));
  const env = process.env['ENGRAM_API_TOKEN'];
  if (!env) return new Set();
  return new Set(env.split(',').map(t => t.trim()).filter(Boolean));
}

/** Extract rate limit config from env vars */
function envRateLimit(): RateLimitConfig | false {
  if (process.env['ENGRAM_RATE_LIMIT'] === 'off') return false;
  return {
    burst: Number(process.env['ENGRAM_RATE_BURST'] ?? 60),
    refillPerSecond: Number(process.env['ENGRAM_RATE_PER_SEC'] ?? 10),
    idleTimeoutMs: 300_000,
  };
}

export function createApp(defaultCore: EngramCore, opts: ApiOptions = {}): Hono {
  const app = new Hono();
  const allowPerRequest = opts.allowPerRequestNamespace ?? true;

  // Per-namespace core cache (reused across requests for same namespace)
  const coreCache = new Map<string, EngramCore>();
  coreCache.set(defaultCore.config.namespace, defaultCore);

  /** Resolve which EngramCore to use for this request */
  function resolveCore(c: any): EngramCore {
    if (!allowPerRequest) return defaultCore;

    const nsFromQuery = c.req.query('namespace');
    const nsFromHeader = c.req.header('x-engram-namespace');
    const requested = nsFromQuery ?? nsFromHeader;

    if (!requested || requested === defaultCore.config.namespace) {
      return defaultCore;
    }

    if (!validateNamespace(requested)) {
      throw new Error('Invalid namespace format');
    }

    let cached = coreCache.get(requested);
    if (!cached) {
      cached = createEngramCore({ namespace: requested });
      coreCache.set(requested, cached);
    }
    return cached;
  }

  const corsOrigin = process.env['ENGRAM_CORS_ORIGIN'] ?? '*';
  app.use('*', cors({ origin: corsOrigin }));

  // Auth: Bearer token. Applied BEFORE rate limit so unauthenticated requests
  // don't consume rate budget.
  const tokens = resolveAuthTokens(opts.authTokens);
  if (tokens.size > 0) {
    app.use('*', async (c, next) => {
      // Exempt health from auth so load balancers / monitors can probe
      if (c.req.path === '/api/health') return next();

      const header = c.req.header('authorization') ?? '';
      if (!header.startsWith('Bearer ')) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }
      const provided = header.slice(7).trim();
      if (!tokens.has(provided)) {
        return c.json({ error: 'Invalid token' }, 403);
      }
      return next();
    });
  }

  // Rate limiting (per remote address)
  const rlConfig = opts.rateLimit ?? envRateLimit();
  const limiter = rlConfig === false ? null : new RateLimiter(rlConfig);

  // C-B1: only trust X-Forwarded-For when explicitly opted-in
  const trustProxy = process.env['ENGRAM_TRUST_PROXY'] === '1'
    || process.env['ENGRAM_TRUST_PROXY'] === 'true';

  if (limiter) {
    // Lazy import so tests without @hono/node-server still run
    const conninfoPromise = import('@hono/node-server/conninfo').then(m => m.getConnInfo);

    app.use('*', async (c, next) => {
      // Monitoring endpoints exempt
      if (c.req.path === '/api/health' || c.req.path === '/api/metrics') {
        return next();
      }

      const key = await resolveClientKey(c, trustProxy, await conninfoPromise);
      const { allowed, retryAfterMs } = limiter.tryConsume(key);
      if (!allowed) {
        c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        c.header('X-RateLimit-Burst', String(limiter.config.burst));
        c.header('X-RateLimit-Refill-Per-Sec', String(limiter.config.refillPerSecond));
        return c.json({ error: 'Too many requests', retry_after_ms: retryAfterMs }, 429);
      }
      return next();
    });
  }

  // Request logging + metrics
  app.use('*', async (c, next) => {
    const requestId = newRequestId();
    const stop = startTimer();
    const method = c.req.method;
    const path = c.req.path;

    c.header('X-Request-ID', requestId);
    await next();

    const duration = stop();
    const status = c.res.status;
    const labels = { method, path: normalizePath(path), status: String(status) };

    metrics.apiRequests.inc(labels);
    metrics.apiDuration.observe(labels, duration);
    if (status >= 400) metrics.apiErrors.inc(labels);

    log.info('http', { requestId, method, path, status, duration_ms: Math.round(duration * 1000) });
  });

  // ─── Metrics ───────────────────────────────────

  app.get('/api/metrics', (c) => {
    return c.text(renderMetrics(), 200, { 'Content-Type': 'text/plain; version=0.0.4' });
  });

  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', version: '0.1.0' });
  });

  // ─── Status ────────────────────────────────────

  app.get('/api/status', (c) => {
    const core = resolveCore(c);
    return c.json(svc.getStatus(core));
  });

  // ─── Namespaces ────────────────────────────────

  app.get('/api/namespaces', (c) => {
    const list = svc.listNamespaces(defaultCore);
    return c.json({ namespaces: list, current: defaultCore.config.namespace });
  });

  // ─── Nodes ─────────────────────────────────────

  app.get('/api/nodes', (c) => {
    const core = resolveCore(c);
    const type = c.req.query('type');
    const limit = safeInt(c.req.query('limit'), 50);
    const nodes = svc.listNodes(core, { type: type || undefined, limit });
    return c.json({ nodes, count: nodes.length, namespace: core.config.namespace });
  });

  app.get('/api/nodes/:id', (c) => {
    const core = resolveCore(c);
    const detail = svc.getNodeDetail(core, c.req.param('id'));
    if (!detail) return c.json({ error: 'Node not found' }, 404);
    return c.json(detail);
  });

  // ─── Edges ─────────────────────────────────────

  app.get('/api/edges/:nodeId', (c) => {
    const core = resolveCore(c);
    const result = svc.getEdgesForNode(core, c.req.param('nodeId'));
    if (!result) return c.json({ error: 'Node not found' }, 404);
    return c.json(result);
  });

  // ─── Search ────────────────────────────────────

  app.get('/api/search', (c) => {
    const core = resolveCore(c);
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'Query parameter "q" is required' }, 400);
    const limit = safeInt(c.req.query('limit'), 20);
    const results = svc.searchNodes(core, q, limit);
    return c.json({ results, count: results.length, namespace: core.config.namespace });
  });

  // ─── Events ────────────────────────────────────

  app.get('/api/events', (c) => {
    const core = resolveCore(c);
    const limit = safeInt(c.req.query('limit'), 20);
    const typeParam = c.req.query('type');
    const type = typeParam && VALID_EVENT_TYPES.includes(typeParam as any)
      ? typeParam as typeof VALID_EVENT_TYPES[number]
      : undefined;
    if (typeParam && !type) {
      return c.json({ error: `Invalid type. Valid: ${VALID_EVENT_TYPES.join(', ')}` }, 400);
    }
    const events = svc.listEvents(core, { limit, type });
    return c.json({ events, count: events.length, namespace: core.config.namespace });
  });

  // ─── Context ───────────────────────────────────

  app.post('/api/context', async (c) => {
    const core = resolveCore(c);
    let body: z.infer<typeof contextBodySchema>;
    try {
      const raw = await c.req.json();
      body = contextBodySchema.parse(raw);
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.errors.map(e => e.message).join(', ')
        : 'Invalid JSON body';
      return c.json({ error: message }, 400);
    }

    const context = await svc.getContext(core, {
      topic: body.topic,
      entities: body.entities,
      maxTokens: body.max_tokens,
      strategy: body.strategy,
    });
    return c.json({ context, namespace: core.config.namespace });
  });

  // ─── Merge ─────────────────────────────────────

  const mergeBodySchema = z.object({
    source: z.string().min(1).max(512),
    target: z.string().min(1).max(512),
  });

  app.post('/api/merge', async (c) => {
    const core = resolveCore(c);
    let body: z.infer<typeof mergeBodySchema>;
    try {
      body = mergeBodySchema.parse(await c.req.json());
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.errors.map(e => e.message).join(', ')
        : 'Invalid JSON body';
      return c.json({ error: message }, 400);
    }
    try {
      const result = svc.mergeNodes(core, body.source, body.target);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ─── Export / Import ───────────────────────────

  app.get('/api/export', (c) => {
    const core = resolveCore(c);
    const includeArchived = c.req.query('archived') !== 'false';
    const includeEvents = c.req.query('events') !== 'false';
    const includeHistory = c.req.query('history') !== 'false';
    const bundle = svc.exportNamespace(core, { includeArchived, includeEvents, includeHistory });
    return c.json(bundle);
  });

  const importBodySchema = z.object({
    bundle: z.record(z.unknown()),
    strategy: z.enum(['skip', 'overwrite', 'merge', 'reassign']).optional(),
    targetNamespace: z.string().max(64).optional(),
  });

  app.post('/api/import', async (c) => {
    let body: z.infer<typeof importBodySchema>;
    try {
      body = importBodySchema.parse(await c.req.json());
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.errors.map(e => e.message).join(', ')
        : 'Invalid JSON body';
      return c.json({ error: message }, 400);
    }

    const targetNs = body.targetNamespace ?? (body.bundle as any).namespace;
    // Import writes go into the namespaced core — resolve explicitly
    const targetCore = (() => {
      if (!targetNs || targetNs === defaultCore.config.namespace) return defaultCore;
      if (!validateNamespace(targetNs)) throw new Error('Invalid target namespace format');
      let cached = coreCache.get(targetNs);
      if (!cached) {
        cached = createEngramCore({ namespace: targetNs });
        coreCache.set(targetNs, cached);
      }
      return cached;
    })();

    try {
      const result = svc.importBundle(targetCore, body.bundle as unknown as svc.ExportBundle, {
        targetNamespace: body.targetNamespace,
        conflictStrategy: body.strategy,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ─── History ───────────────────────────────────

  app.get('/api/history/:nodeId', (c) => {
    const core = resolveCore(c);
    const result = svc.getNodeHistory(core, c.req.param('nodeId'));
    if (!result) return c.json({ error: 'Node not found' }, 404);
    return c.json(result);
  });

  // ─── Error handler ─────────────────────────────

  app.onError((err, c) => {
    // Namespace validation errors are client errors (400); others are 500
    if (err.message.includes('namespace') || err.message.includes('Invalid')) {
      return c.json({ error: err.message }, 400);
    }
    console.error('API error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
