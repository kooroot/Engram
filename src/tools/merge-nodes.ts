import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { EngineCache } from '../engine/cache.js';

export function registerMergeNodes(
  server: McpServer,
  stateTree: StateTree,
  cache: EngineCache,
): void {
  server.registerTool('merge_nodes', {
    description: 'Merge two duplicate nodes. Re-points all edges from source to target, merges properties (target wins on conflict), and archives source. Use when you detect duplicates that should be unified.',
    inputSchema: {
      source_id: z.string().describe('ID of the node to be merged away (archived)'),
      target_id: z.string().describe('ID of the node that will survive as the canonical entity'),
    },
  }, async ({ source_id, target_id }) => {
    try {
      const result = stateTree.mergeNodes(source_id, target_id);
      cache.invalidateNode(source_id);
      cache.invalidateNode(target_id);
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
