import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { EngineCache } from '../engine/cache.js';
import type { MutationOp } from '../types/index.js';
import { detectDuplicates } from '../engine/conflict-resolver.js';
import { propertiesSchema } from './schemas.js';

// `.passthrough()` so MCP clients (e.g. Gemini CLI) that include extra
// fields in the operation object don't get rejected with
// `additionalProperties` validation errors. Extras are silently dropped
// at type-cast time inside the handler.
const createOp = z.object({
  op: z.literal('create'),
  type: z.string().max(64).describe('Node type (person, project, concept, rule, fact)'),
  name: z.string().max(512).describe('Canonical name of the entity'),
  properties: propertiesSchema.describe('Key-value attributes'),
  summary: z.string().max(2000).optional().describe('Compact text summary for context injection'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence score (0-1)'),
}).passthrough();

const updateOp = z.object({
  op: z.literal('update'),
  node_id: z.string().describe('ID of the node to update'),
  set: propertiesSchema.describe('Properties to set or merge'),
  unset: z.array(z.string().max(128)).max(100).optional().describe('Property keys to remove'),
  name: z.string().max(512).optional().describe('New name'),
  summary: z.string().max(2000).optional().describe('Updated summary'),
  confidence: z.number().min(0).max(1).optional().describe('Updated confidence'),
}).passthrough();

const deleteOp = z.object({
  op: z.literal('delete'),
  node_id: z.string().describe('ID of the node to delete'),
}).passthrough();

const opSchema = z.union([createOp, updateOp, deleteOp]);

export function registerMutateState(server: McpServer, stateTree: StateTree, cache: EngineCache): void {
  server.registerTool('mutate_state', {
    description:
      'Create, update, or delete nodes in the Cognitive State Tree. ' +
      'Pass `operations: [{op:"create"|"update"|"delete", ...}]` for one or more atomic mutations. ' +
      'A single flat operation (no `operations` wrapper) is also accepted and auto-wrapped.',
    inputSchema: {
      operations: z.array(opSchema).max(50).optional()
        .describe('Array of mutation operations (max 50). When omitted, a flat single op may be passed at the top level.'),
      // Flat single-op fallback fields — recognised when `operations` is absent.
      op: z.enum(['create', 'update', 'delete']).optional()
        .describe('(flat single-op) Mutation kind. Use this with the matching shape fields below instead of `operations`.'),
      type: z.string().max(64).optional().describe('(flat create) Node type'),
      name: z.string().max(512).optional().describe('(flat create/update) Node name'),
      properties: propertiesSchema.describe('(flat create) Properties'),
      summary: z.string().max(2000).optional().describe('(flat create/update) Summary'),
      confidence: z.number().min(0).max(1).optional().describe('(flat) Confidence'),
      node_id: z.string().optional().describe('(flat update/delete) Target node id'),
      set: propertiesSchema.describe('(flat update) Properties to set'),
      unset: z.array(z.string().max(128)).max(100).optional().describe('(flat update) Properties to remove'),
    },
  }, async (input) => {
    try {
      const ops = normalizeOperations(input);
      if (ops.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: provide `operations` array, or flat single-op fields with `op`.' }],
          isError: true,
        };
      }

      const warnings: string[] = [];
      for (const op of ops) {
        if (op.op === 'create') {
          const dupes = detectDuplicates(stateTree, op.type, op.name);
          if (dupes.length > 0) {
            const existing = dupes[0].existing;
            warnings.push(
              `Warning: "${op.name}" (${op.type}) already exists as node ${existing.id}. Consider updating instead.`,
            );
          }
        }
      }

      const result = stateTree.mutate(ops);

      for (const r of result.results) {
        cache.invalidateNode(r.node_id);
      }

      const response: Record<string, unknown> = { ...result };
      if (warnings.length > 0) response['warnings'] = warnings;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
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

/**
 * Accept either:
 *   { operations: [{ op, ... }, ...] }     — canonical
 *   { op, type, name, ... }                — flat single-op convenience
 * and produce a clean MutationOp[]. Strips fields that aren't part of
 * the destination op shape so passthrough'd extras don't reach the DB.
 */
function normalizeOperations(input: Record<string, unknown>): MutationOp[] {
  const list = Array.isArray(input['operations']) && input['operations'].length > 0
    ? input['operations'] as Record<string, unknown>[]
    : (input['op'] ? [input as Record<string, unknown>] : []);
  return list.map(stripExtras).filter(Boolean) as MutationOp[];
}

function stripExtras(raw: Record<string, unknown>): MutationOp | null {
  const op = raw['op'];
  if (op === 'create') {
    return {
      op: 'create',
      type: raw['type'] as string,
      name: raw['name'] as string,
      properties: (raw['properties'] as Record<string, unknown> | undefined) ?? {},
      summary: raw['summary'] as string | undefined,
      confidence: raw['confidence'] as number | undefined,
    };
  }
  if (op === 'update') {
    return {
      op: 'update',
      node_id: raw['node_id'] as string,
      set: (raw['set'] as Record<string, unknown> | undefined) ?? {},
      unset: raw['unset'] as string[] | undefined,
      name: raw['name'] as string | undefined,
      summary: raw['summary'] as string | undefined,
      confidence: raw['confidence'] as number | undefined,
    };
  }
  if (op === 'delete') {
    return {
      op: 'delete',
      node_id: raw['node_id'] as string,
    };
  }
  return null;
}
