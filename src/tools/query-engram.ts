import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { Node, Edge } from '../types/index.js';
import { traverseGraph } from '../engine/graph-traversal.js';
import { buildContext, estimateTokens } from '../engine/context-builder.js';

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
      format: z.enum(['json', 'text']).default('json')
        .describe('json = structured response; text = compact LLM-ready serialization'),
      max_tokens: z.number().min(100).max(8000).optional()
        .describe('Token budget; when set, truncates lowest-confidence nodes to fit'),
      include_properties: z.boolean().default(true)
        .describe('Include raw properties in response; set false to save tokens'),
    },
  }, async ({ node_id, node_name, node_type, traverse, include_archived, limit, format, max_tokens, include_properties }) => {
    try {
      // Direct lookup mode
      if (node_id || node_name) {
        const node = node_id
          ? stateTree.getNode(node_id)
          : stateTree.getNodeByName(node_name!);

        if (!node) {
          return {
            content: [{
              type: 'text' as const,
              text: renderEmpty(format),
            }],
          };
        }

        const edges = [
          ...stateTree.getEdgesFrom(node.id),
          ...stateTree.getEdgesTo(node.id),
        ];

        return {
          content: [{
            type: 'text' as const,
            text: renderResult([node], edges, 0, { format, max_tokens, include_properties }),
          }],
        };
      }

      // Type query mode
      if (node_type && !traverse) {
        const nodes = stateTree.getNodesByType(node_type, limit);
        return {
          content: [{
            type: 'text' as const,
            text: renderResult(nodes, [], 0, { format, max_tokens, include_properties }),
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

        // Apply node limit
        if (result.nodes.length > limit) {
          result.nodes = result.nodes.slice(0, limit);
        }

        return {
          content: [{
            type: 'text' as const,
            text: renderResult(result.nodes, result.edges, result.meta.depth_reached, { format, max_tokens, include_properties }),
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

interface RenderOpts {
  format: 'json' | 'text';
  max_tokens?: number;
  include_properties: boolean;
}

function renderEmpty(format: 'json' | 'text'): string {
  if (format === 'text') return 'No matching nodes.';
  return JSON.stringify({ nodes: [], edges: [], meta: { total_nodes: 0, depth_reached: 0 } });
}

function renderResult(nodes: Node[], edges: Edge[], depthReached: number, opts: RenderOpts): string {
  if (opts.format === 'text') {
    if (nodes.length === 0) return 'No matching nodes.';
    return buildContext(nodes, edges, {
      maxTokens: opts.max_tokens ?? 2000,
      includeProperties: opts.include_properties,
      includeEdges: true,
    });
  }

  // JSON mode
  const shaped = opts.include_properties
    ? nodes
    : nodes.map(stripProperties);

  // Fast path: no budget
  if (opts.max_tokens === undefined) {
    return JSON.stringify({
      nodes: shaped,
      edges,
      meta: { total_nodes: shaped.length, depth_reached: depthReached },
    });
  }

  // Budgeted: drop lowest-confidence nodes until under budget
  const sorted = [...shaped].sort((a, b) =>
    b.confidence !== a.confidence ? b.confidence - a.confidence
      : b.updated_at.localeCompare(a.updated_at),
  );

  let kept = sorted;
  let truncated = false;
  while (kept.length > 0) {
    const keptIds = new Set(kept.map(n => n.id));
    const filteredEdges = edges.filter(e => keptIds.has(e.source_id) && keptIds.has(e.target_id));
    const payload = {
      nodes: kept,
      edges: filteredEdges,
      meta: {
        total_nodes: kept.length,
        depth_reached: depthReached,
        ...(truncated ? { truncated: true, original_count: shaped.length } : {}),
      },
    };
    const serialized = JSON.stringify(payload);
    if (estimateTokens(serialized) <= opts.max_tokens) return serialized;
    kept = kept.slice(0, Math.max(1, kept.length - Math.max(1, Math.floor(kept.length / 4))));
    truncated = true;
    if (kept.length === 1) {
      // Final attempt: return single top node even if over budget (better than nothing)
      const keptIds2 = new Set(kept.map(n => n.id));
      const filteredEdges2 = edges.filter(e => keptIds2.has(e.source_id) && keptIds2.has(e.target_id));
      return JSON.stringify({
        nodes: kept,
        edges: filteredEdges2,
        meta: { total_nodes: 1, depth_reached: depthReached, truncated: true, original_count: shaped.length },
      });
    }
  }

  return JSON.stringify({ nodes: [], edges: [], meta: { total_nodes: 0, depth_reached: depthReached, truncated: true, original_count: shaped.length } });
}

function stripProperties(node: Node): Node {
  return { ...node, properties: {} };
}
