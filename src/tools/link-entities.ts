import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { EngineCache } from '../engine/cache.js';
import type { LinkOp } from '../types/index.js';
import { propertiesSchema } from './schemas.js';

// `.passthrough()` so MCP clients (e.g. Gemini CLI) that include extra
// fields don't get rejected with `additionalProperties` validation errors.
const createLinkOp = z.object({
  op: z.literal('create'),
  source_id: z.string().describe('Source node ID'),
  predicate: z.string().max(128).describe('Relationship type (e.g., works_on, knows, is_a)'),
  target_id: z.string().describe('Target node ID'),
  properties: propertiesSchema.describe('Edge metadata'),
  confidence: z.number().min(0).max(1).optional(),
}).passthrough();

const updateLinkOp = z.object({
  op: z.literal('update'),
  edge_id: z.string().optional().describe('Edge ID (alternative to triplet)'),
  source_id: z.string().optional(),
  predicate: z.string().max(128).optional(),
  target_id: z.string().optional(),
  set: propertiesSchema.describe('Properties to merge'),
  confidence: z.number().min(0).max(1).optional(),
}).passthrough();

const deleteLinkOp = z.object({
  op: z.literal('delete'),
  edge_id: z.string().optional(),
  source_id: z.string().optional(),
  predicate: z.string().max(128).optional(),
  target_id: z.string().optional(),
}).passthrough();

const linkOpSchema = z.union([createLinkOp, updateLinkOp, deleteLinkOp]);

export function registerLinkEntities(server: McpServer, stateTree: StateTree, cache: EngineCache): void {
  server.registerTool('link_entities', {
    description:
      'Create, update, or delete edges (relationships) between nodes. ' +
      'Pass `operations: [{op:"create", source_id, predicate, target_id, ...}]`. ' +
      'A flat single-op (no `operations` wrapper) is also accepted and auto-wrapped. ' +
      'Duplicate triplets on create are upserted.',
    inputSchema: {
      operations: z.array(linkOpSchema).max(50).optional()
        .describe('Array of link operations (max 50). When omitted, a flat single op may be passed at the top level.'),
      // Flat single-op fallback fields
      op: z.enum(['create', 'update', 'delete']).optional()
        .describe('(flat single-op) Operation kind. Use with the matching shape fields below instead of `operations`.'),
      source_id: z.string().optional().describe('(flat) Source node id'),
      predicate: z.string().max(128).optional().describe('(flat) Edge predicate'),
      target_id: z.string().optional().describe('(flat) Target node id'),
      properties: propertiesSchema.describe('(flat create) Edge metadata'),
      confidence: z.number().min(0).max(1).optional(),
      edge_id: z.string().optional().describe('(flat update/delete) Edge id'),
      set: propertiesSchema.describe('(flat update) Properties to set'),
    },
  }, async (input) => {
    try {
      const ops = normalizeLinkOps(input);
      if (ops.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: provide `operations` array, or flat single-op fields with `op`.' }],
          isError: true,
        };
      }

      const result = stateTree.link(ops);

      const nodeIds = new Set<string>();
      for (const op of ops) {
        if ('source_id' in op && op.source_id) nodeIds.add(op.source_id);
        if ('target_id' in op && op.target_id) nodeIds.add(op.target_id);
      }
      for (const nodeId of nodeIds) {
        cache.invalidateNode(nodeId);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  });
}

function normalizeLinkOps(input: Record<string, unknown>): LinkOp[] {
  const list = Array.isArray(input['operations']) && input['operations'].length > 0
    ? input['operations'] as Record<string, unknown>[]
    : (input['op'] ? [input as Record<string, unknown>] : []);
  return list.map(stripExtras).filter(Boolean) as LinkOp[];
}

function stripExtras(raw: Record<string, unknown>): LinkOp | null {
  const op = raw['op'];
  if (op === 'create') {
    return {
      op: 'create',
      source_id: raw['source_id'] as string,
      predicate: raw['predicate'] as string,
      target_id: raw['target_id'] as string,
      properties: (raw['properties'] as Record<string, unknown> | undefined) ?? {},
      confidence: raw['confidence'] as number | undefined,
    };
  }
  if (op === 'update') {
    return {
      op: 'update',
      edge_id: raw['edge_id'] as string | undefined,
      source_id: raw['source_id'] as string | undefined,
      predicate: raw['predicate'] as string | undefined,
      target_id: raw['target_id'] as string | undefined,
      set: (raw['set'] as Record<string, unknown> | undefined) ?? {},
      confidence: raw['confidence'] as number | undefined,
    };
  }
  if (op === 'delete') {
    return {
      op: 'delete',
      edge_id: raw['edge_id'] as string | undefined,
      source_id: raw['source_id'] as string | undefined,
      predicate: raw['predicate'] as string | undefined,
      target_id: raw['target_id'] as string | undefined,
    };
  }
  return null;
}
