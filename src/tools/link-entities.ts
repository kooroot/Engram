import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { LinkOp } from '../types/index.js';

const createLinkOp = z.object({
  op: z.literal('create'),
  source_id: z.string().describe('Source node ID'),
  predicate: z.string().describe('Relationship type (e.g., works_on, knows, is_a)'),
  target_id: z.string().describe('Target node ID'),
  properties: z.record(z.unknown()).optional().describe('Edge metadata'),
  confidence: z.number().min(0).max(1).optional(),
});

const updateLinkOp = z.object({
  op: z.literal('update'),
  edge_id: z.string().optional().describe('Edge ID (alternative to triplet)'),
  source_id: z.string().optional(),
  predicate: z.string().optional(),
  target_id: z.string().optional(),
  set: z.record(z.unknown()).optional().describe('Properties to merge'),
  confidence: z.number().min(0).max(1).optional(),
});

const deleteLinkOp = z.object({
  op: z.literal('delete'),
  edge_id: z.string().optional(),
  source_id: z.string().optional(),
  predicate: z.string().optional(),
  target_id: z.string().optional(),
});

export function registerLinkEntities(server: McpServer, stateTree: StateTree): void {
  server.registerTool('link_entities', {
    description: 'Create, update, or delete edges (relationships) between nodes. Duplicate triplets are automatically upserted.',
    inputSchema: {
      operations: z.array(z.union([createLinkOp, updateLinkOp, deleteLinkOp]))
        .describe('Array of link operations'),
    },
  }, async ({ operations }) => {
    try {
      const result = stateTree.link(operations as LinkOp[]);
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
