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

        // Capped per direction: a hub node with thousands of edges used to
        // produce a multi-MB response. Keeps the highest-confidence /
        // most-recent edges — the same order the text renderer displays.
        const edges = stateTree.getEdgesForNodes([node.id], DIRECT_LOOKUP_EDGE_CAP);

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

/** Max edges fetched per direction in direct-lookup mode. */
const DIRECT_LOOKUP_EDGE_CAP = 100;

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

  // Budgeted: keep the LARGEST top-k prefix (by confidence, then recency)
  // that fits the token budget. Each node/edge is serialized exactly once and
  // candidate payload sizes are computed from prefix sums — the previous loop
  // re-stringified the entire payload on every 25% shrink (up to ~17 full
  // serializations of megabyte payloads) and could overshoot, returning fewer
  // nodes than the budget allowed.
  //
  // Edges are kept when AT LEAST ONE endpoint is kept (matching the text
  // renderer, which displays half-dangling edges by id). The old
  // both-endpoints filter silently dropped EVERY edge in direct-lookup mode,
  // where neighbor nodes are never part of `nodes`.
  const sorted = [...shaped].sort((a, b) =>
    b.confidence !== a.confidence ? b.confidence - a.confidence
      : b.updated_at.localeCompare(a.updated_at),
  );

  const nodeStrs = sorted.map(n => JSON.stringify(n));
  const edgeStrs = edges.map(e => JSON.stringify(e));

  // Map each edge to the smallest k at which it becomes included (the rank of
  // its earliest-kept endpoint). Edges touching no sorted node are never kept.
  const rankOf = new Map<string, number>();
  sorted.forEach((n, i) => rankOf.set(n.id, i));
  const edgeMinK = edges.map(e => {
    const rs = rankOf.get(e.source_id);
    const rt = rankOf.get(e.target_id);
    if (rs === undefined && rt === undefined) return Infinity;
    return Math.min(rs ?? Infinity, rt ?? Infinity) + 1;
  });

  const metaStr = (k: number, truncated: boolean) => JSON.stringify({
    total_nodes: k,
    depth_reached: depthReached,
    ...(truncated ? { truncated: true, original_count: shaped.length } : {}),
  });

  // Exact serialized length of the k-prefix payload, built from parts:
  // {"nodes":[a,b],"edges":[c],"meta":{...}}
  const assemble = (k: number): string => {
    const keptNodes = nodeStrs.slice(0, k);
    const keptEdges: string[] = [];
    for (let i = 0; i < edgeStrs.length; i++) {
      if (edgeMinK[i]! <= k) keptEdges.push(edgeStrs[i]!);
    }
    const truncated = k < sorted.length;
    return `{"nodes":[${keptNodes.join(',')}],"edges":[${keptEdges.join(',')}],"meta":${metaStr(k, truncated)}}`;
  };
  const fits = (k: number): boolean =>
    estimateTokens(assemble(k)) <= opts.max_tokens!;

  // Fast path: everything fits.
  if (sorted.length > 0 && fits(sorted.length)) return assemble(sorted.length);

  // Binary search the largest fitting k (k=1 is returned even when over
  // budget — a single top node beats an empty response).
  let lo = 1;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  if (sorted.length === 0) {
    return `{"nodes":[],"edges":[],"meta":${metaStr(0, true)}}`;
  }
  return assemble(Math.max(1, lo));
}

function stripProperties(node: Node): Node {
  return { ...node, properties: {} };
}
