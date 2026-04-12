import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { EngineCache } from '../engine/cache.js';
import type { LinkOp } from '../types/index.js';

const propertiesSchema = z.record(z.unknown()).optional()
  .refine(val => !val || Object.keys(val).length <= 100,
    { message: 'Properties must have at most 100 keys' });

const createLinkOp = z.object({
  op: z.literal('create'),
  source_id: z.string().describe('Source node ID'),
  predicate: z.string().max(128).describe('Relationship type (e.g., works_on, knows, is_a)'),
  target_id: z.string().describe('Target node ID'),
  properties: propertiesSchema.describe('Edge metadata'),
  confidence: z.number().min(0).max(1).optional(),
});

const updateLinkOp = z.object({
  op: z.literal('update'),
  edge_id: z.string().optional().describe('Edge ID (alternative to triplet)'),
  source_id: z.string().optional(),
  predicate: z.string().max(128).optional(),
  target_id: z.string().optional(),
  set: propertiesSchema.describe('Properties to merge'),
  confidence: z.number().min(0).max(1).optional(),
});

const deleteLinkOp = z.object({
  op: z.literal('delete'),
  edge_id: z.string().optional(),
  source_id: z.string().optional(),
  predicate: z.string().max(128).optional(),
  target_id: z.string().optional(),
});

export function registerLinkEntities(server: McpServer, stateTree: StateTree, cache: EngineCache): void {
  server.registerTool('link_entities', {
    description: 'Create, update, or delete edges (relationships) between nodes. Duplicate triplets are automatically upserted.',
    inputSchema: {
      operations: z.array(z.union([createLinkOp, updateLinkOp, deleteLinkOp])).max(50)
        .describe('Array of link operations (max 50)'),
    },
  }, async ({ operations }) => {
    try {
      const result = stateTree.link(operations as LinkOp[]);

      // H2: Invalidate cache — edges affect context for connected nodes
      // Collect all node IDs referenced in operations
      const nodeIds = new Set<string>();
      for (const op of operations) {
        if ('source_id' in op && op.source_id) nodeIds.add(op.source_id);
        if ('target_id' in op && op.target_id) nodeIds.add(op.target_id);
      }
      for (const nodeId of nodeIds) {
        cache.invalidateNode(nodeId);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
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
