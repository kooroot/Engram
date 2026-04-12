import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { EngramCore } from '../service.js';
import * as svc from '../service.js';

const VALID_EVENT_TYPES = ['observation', 'action', 'mutation', 'query', 'system'] as const;

// H2: Zod schema for POST /api/context body validation
const contextBodySchema = z.object({
  topic: z.string().max(1000).optional(),
  entities: z.array(z.string().max(512)).max(20).optional(),
  max_tokens: z.number().min(100).max(8000).optional(),
});

/** Parse int with fallback — M2 fix */
function safeInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createApp(core: EngramCore): Hono {
  const app = new Hono();

  // M3: CORS origin configurable via env, defaults to open for local dev
  const corsOrigin = process.env['ENGRAM_CORS_ORIGIN'] ?? '*';
  app.use('*', cors({ origin: corsOrigin }));

  // ─── Status ────────────────────────────────────

  app.get('/api/status', (c) => {
    return c.json(svc.getStatus(core));
  });

  // ─── Nodes ─────────────────────────────────────

  app.get('/api/nodes', (c) => {
    const type = c.req.query('type');
    const limit = safeInt(c.req.query('limit'), 50);
    const nodes = svc.listNodes(core, { type: type || undefined, limit });
    return c.json({ nodes, count: nodes.length });
  });

  app.get('/api/nodes/:id', (c) => {
    const detail = svc.getNodeDetail(core, c.req.param('id'));
    if (!detail) return c.json({ error: 'Node not found' }, 404);
    return c.json(detail);
  });

  // ─── Edges ─────────────────────────────────────

  app.get('/api/edges/:nodeId', (c) => {
    const result = svc.getEdgesForNode(core, c.req.param('nodeId'));
    if (!result) return c.json({ error: 'Node not found' }, 404);
    return c.json(result);
  });

  // ─── Search ────────────────────────────────────

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'Query parameter "q" is required' }, 400);
    const limit = safeInt(c.req.query('limit'), 20);
    const results = svc.searchNodes(core, q, limit);
    return c.json({ results, count: results.length });
  });

  // ─── Events ────────────────────────────────────

  app.get('/api/events', (c) => {
    const limit = safeInt(c.req.query('limit'), 20);
    const typeParam = c.req.query('type');
    // L1: Validate event type
    const type = typeParam && VALID_EVENT_TYPES.includes(typeParam as any)
      ? typeParam as typeof VALID_EVENT_TYPES[number]
      : undefined;
    if (typeParam && !type) {
      return c.json({ error: `Invalid type. Valid: ${VALID_EVENT_TYPES.join(', ')}` }, 400);
    }
    const events = svc.listEvents(core, { limit, type });
    return c.json({ events, count: events.length });
  });

  // ─── Context ───────────────────────────────────

  app.post('/api/context', async (c) => {
    // H2: Validate request body
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

    const context = svc.getContext(core, {
      topic: body.topic,
      entities: body.entities,
      maxTokens: body.max_tokens,
    });
    return c.json({ context });
  });

  // ─── History ───────────────────────────────────

  app.get('/api/history/:nodeId', (c) => {
    const result = svc.getNodeHistory(core, c.req.param('nodeId'));
    if (!result) return c.json({ error: 'Node not found' }, 404);
    return c.json(result);
  });

  // ─── Error handler ─────────────────────────────

  app.onError((err, c) => {
    console.error('API error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
