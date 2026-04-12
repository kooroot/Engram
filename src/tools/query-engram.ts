import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import { traverseGraph } from '../engine/graph-traversal.js';

export function registerQueryEngram(server: McpServer, stateTree: StateTree): void {
  server.registerTool('query_engram', {
    description: 'Query the Cognitive State Tree. Lookup nodes by ID/name/type, or traverse the graph from a starting node.',
    inputSchema: {
      node_id: z.string().optional().describe('Direct node lookup by ID'),
      node_name: z.string().optional().describe('Lookup by name'),
      node_type: z.string().optional().describe('Filter by node type'),
      traverse: z.object({
        from: z.string().describe('Starting node ID or name'),
        predicates: z.array(z.string()).optional().describe('Filter by edge types'),
        direction: z.enum(['outgoing', 'incoming', 'both']).default('both'),
        depth: z.number().min(1).max(5).default(1).describe('Traversal depth (1-5)'),
      }).optional().describe('Graph traversal parameters'),
      include_archived: z.boolean().default(false),
      limit: z.number().min(1).max(100).default(20),
    },
  }, async ({ node_id, node_name, node_type, traverse, include_archived, limit }) => {
    try {
      // Direct lookup mode
      if (node_id || node_name) {
        const node = node_id
          ? stateTree.getNode(node_id)
          : stateTree.getNodeByName(node_name!);

        if (!node) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ nodes: [], edges: [], meta: { total_nodes: 0, depth_reached: 0 } }) }],
          };
        }

        const edges = [
          ...stateTree.getEdgesFrom(node.id),
          ...stateTree.getEdgesTo(node.id),
        ];

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              nodes: [node],
              edges,
              meta: { total_nodes: 1, depth_reached: 0 },
            }),
          }],
        };
      }

      // Type query mode
      if (node_type && !traverse) {
        const nodes = stateTree.getNodesByType(node_type, limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              nodes,
              edges: [],
              meta: { total_nodes: nodes.length, depth_reached: 0 },
            }),
          }],
        };
      }

      // Graph traversal mode
      if (traverse) {
        const result = traverseGraph(stateTree, {
          from: traverse.from,
          predicates: traverse.predicates,
          direction: traverse.direction,
          depth: traverse.depth,
          includeArchived: include_archived,
        });

        // Apply limit to nodes
        if (result.nodes.length > limit) {
          result.nodes = result.nodes.slice(0, limit);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: 'Error: Provide node_id, node_name, node_type, or traverse parameters',
        }],
        isError: true,
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
