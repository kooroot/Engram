import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { MutationOp } from '../types/index.js';

const createOp = z.object({
  op: z.literal('create'),
  type: z.string().describe('Node type (person, project, concept, rule, fact)'),
  name: z.string().describe('Canonical name of the entity'),
  properties: z.record(z.unknown()).optional().describe('Key-value attributes'),
  summary: z.string().optional().describe('Compact text summary for context injection'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence score (0-1)'),
});

const updateOp = z.object({
  op: z.literal('update'),
  node_id: z.string().describe('ID of the node to update'),
  set: z.record(z.unknown()).optional().describe('Properties to set or merge'),
  unset: z.array(z.string()).optional().describe('Property keys to remove'),
  name: z.string().optional().describe('New name'),
  summary: z.string().optional().describe('Updated summary'),
  confidence: z.number().min(0).max(1).optional().describe('Updated confidence'),
});

const deleteOp = z.object({
  op: z.literal('delete'),
  node_id: z.string().describe('ID of the node to delete'),
});

export function registerMutateState(server: McpServer, stateTree: StateTree): void {
  server.registerTool('mutate_state', {
    description: 'Create, update, or delete nodes in the Cognitive State Tree. All operations run in a single atomic transaction.',
    inputSchema: {
      operations: z.array(z.union([createOp, updateOp, deleteOp]))
        .describe('Array of mutation operations to execute atomically'),
    },
  }, async ({ operations }) => {
    try {
      const result = stateTree.mutate(operations as MutationOp[]);
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
