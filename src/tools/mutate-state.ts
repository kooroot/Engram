import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { EngineCache } from '../engine/cache.js';
import type { MutationOp } from '../types/index.js';
import { detectDuplicates } from '../engine/conflict-resolver.js';
import { propertiesSchema } from './schemas.js';

const createOp = z.object({
  op: z.literal('create'),
  type: z.string().max(64).describe('Node type (person, project, concept, rule, fact)'),
  name: z.string().max(512).describe('Canonical name of the entity'),
  properties: propertiesSchema.describe('Key-value attributes'),
  summary: z.string().max(2000).optional().describe('Compact text summary for context injection'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence score (0-1)'),
});

const updateOp = z.object({
  op: z.literal('update'),
  node_id: z.string().describe('ID of the node to update'),
  set: propertiesSchema.describe('Properties to set or merge'),
  unset: z.array(z.string().max(128)).max(100).optional().describe('Property keys to remove'),
  name: z.string().max(512).optional().describe('New name'),
  summary: z.string().max(2000).optional().describe('Updated summary'),
  confidence: z.number().min(0).max(1).optional().describe('Updated confidence'),
});

const deleteOp = z.object({
  op: z.literal('delete'),
  node_id: z.string().describe('ID of the node to delete'),
});

export function registerMutateState(server: McpServer, stateTree: StateTree, cache: EngineCache): void {
  server.registerTool('mutate_state', {
    description: 'Create, update, or delete nodes in the Cognitive State Tree. All operations run in a single atomic transaction.',
    inputSchema: {
      operations: z.array(z.union([createOp, updateOp, deleteOp])).max(50)
        .describe('Array of mutation operations to execute atomically (max 50)'),
    },
  }, async ({ operations }) => {
    try {
      // Dedup check: warn on create operations that match existing nodes
      const warnings: string[] = [];
      const ops = operations as MutationOp[];
      for (const op of ops) {
        if (op.op === 'create') {
          const dupes = detectDuplicates(stateTree, op.type, op.name);
          if (dupes.length > 0) {
            const existing = dupes[0].existing;
            warnings.push(
              `Warning: "${op.name}" (${op.type}) already exists as node ${existing.id}. Consider updating instead.`
            );
          }
        }
      }

      const result = stateTree.mutate(ops);

      // H2: Invalidate cache for all affected nodes
      for (const r of result.results) {
        cache.invalidateNode(r.node_id);
      }

      const response: any = { ...result };
      if (warnings.length > 0) {
        response.warnings = warnings;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
        }],
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
