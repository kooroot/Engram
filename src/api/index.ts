import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { EngramCore } from '../service.js';
import * as svc from '../service.js';
import type { EventType } from '../types/index.js';

export function createApp(core: EngramCore): Hono {
  const app = new Hono();

  app.use('*', cors());

  // ─── Status ────────────────────────────────────

  app.get('/api/status', (c) => {
    const status = svc.getStatus(core);
    return c.json(status);
  });

  // ─── Nodes ─────────────────────────────────────

  app.get('/api/nodes', (c) => {
    const type = c.req.query('type');
    const limit = parseInt(c.req.query('limit') ?? '50');
    const nodes = svc.listNodes(core, { type: type || undefined, limit });
    return c.json({ nodes, count: nodes.length });
  });

  app.get('/api/nodes/:id', (c) => {
    const detail = svc.getNodeDetail(core, c.req.param('id'));
    if (!detail) {
      return c.json({ error: 'Node not found' }, 404);
    }
    return c.json(detail);
  });

  // ─── Edges ─────────────────────────────────────

  app.get('/api/edges/:nodeId', (c) => {
    const result = svc.getEdgesForNode(core, c.req.param('nodeId'));
    if (!result) {
      return c.json({ error: 'Node not found' }, 404);
    }
    return c.json(result);
  });

  // ─── Search ────────────────────────────────────

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: 'Query parameter "q" is required' }, 400);
    }
    const limit = parseInt(c.req.query('limit') ?? '20');
    const results = svc.searchNodes(core, q, limit);
    return c.json({ results, count: results.length });
  });

  // ─── Events ────────────────────────────────────

  app.get('/api/events', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '20');
    const type = c.req.query('type') as EventType | undefined;
    const events = svc.listEvents(core, { limit, type: type || undefined });
    return c.json({ events, count: events.length });
  });

  // ─── Context ───────────────────────────────────

  app.post('/api/context', async (c) => {
    const body = await c.req.json<{
      topic?: string;
      entities?: string[];
      max_tokens?: number;
    }>();
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
    if (!result) {
      return c.json({ error: 'Node not found' }, 404);
    }
    return c.json(result);
  });

  // ─── Error handler ─────────────────────────────

  app.onError((err, c) => {
    console.error('API error:', err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}
