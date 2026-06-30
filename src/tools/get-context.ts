import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { VectorStore } from '../db/vector-store.js';
import type { Node, Edge } from '../types/index.js';
import { expandNeighborhood } from '../engine/graph-traversal.js';
import { buildContext, CONTEXT_MAX_PER_TYPE } from '../engine/context-builder.js';
import { sanitizeFtsQuery } from '../service.js';
import type { EngineCache } from '../engine/cache.js';
import type { EmbeddingProvider } from '../embeddings/index.js';

/** FTS candidate cap for the keyword branch. Kept in line with
 *  service.getContext (CLI/REST) so the MCP and service read paths surface the
 *  same candidate pool — and the per-type cap + 2000-token budget discard most
 *  of a wider pool anyway. */
const FTS_CANDIDATE_LIMIT = 20;

export function registerGetContext(
  server: McpServer,
  stateTree: StateTree,
  vectorStore: VectorStore,
  cache: EngineCache,
  embeddingProvider: EmbeddingProvider | null,
): void {
  server.registerTool('get_context', {
    description: 'Fetch relevant context from the memory graph for injection into the LLM prompt. This is the primary read-path tool.',
    inputSchema: {
      topic: z.string().max(1000).optional().describe('Natural language topic to find context for'),
      entities: z.array(z.string().max(512)).max(20).optional().describe('Known entity names or IDs to include'),
      max_tokens: z.number().min(100).max(8000).default(2000).describe('Token budget for the response'),
      strategy: z.enum(['graph', 'semantic', 'hybrid']).default('hybrid')
        .describe('Search strategy: graph (fast, structured), semantic (fuzzy), hybrid (both)'),
    },
  }, async ({ topic, entities, max_tokens, strategy }) => {
    try {
      const cacheKey = createHash('md5')
        .update(JSON.stringify({ topic, entities, max_tokens, strategy }))
        .digest('hex');

      const cached = cache.getContext(cacheKey);
      if (cached) {
        return { content: [{ type: 'text' as const, text: cached }] };
      }

      const allNodes = new Map<string, Node>();
      const allEdges = new Map<string, Edge>();

      // Candidate gathering — accumulate anchor nodes from every active
      // strategy, then expand ONCE (below). Mirrors service.getContext so the
      // two read paths can't drift.

      // 1. Direct entity resolution
      if (entities && entities.length > 0) {
        for (const entity of entities) {
          const node = stateTree.getNode(entity) ?? stateTree.getNodeByName(entity);
          if (node) allNodes.set(node.id, node);
        }
      }

      // 2. Graph keyword search (FTS5, all node types)
      if (topic && (strategy === 'graph' || strategy === 'hybrid')) {
        for (const node of searchByKeywords(stateTree, topic, FTS_CANDIDATE_LIMIT)) {
          allNodes.set(node.id, node);
        }
      }

      // 3. Semantic search (vector-based)
      if (topic && (strategy === 'semantic' || strategy === 'hybrid')) {
        if (embeddingProvider && vectorStore.isVecEnabled) {
          try {
            const embedding = await embeddingProvider.embed(topic);
            const vecResults = vectorStore.search({
              embedding,
              limit: 10,
              sourceType: 'node',
            });
            for (const result of vecResults) {
              const node = stateTree.getNode(result.source_id);
              if (node && !node.archived) allNodes.set(node.id, node);
            }
          } catch {
            // Embedding failed — fall back to graph results only
          }
        }
      }

      if (allNodes.size === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No relevant context found in memory.',
          }],
        };
      }

      // 4. Single batched depth-1 expansion over all candidates. Replaces the
      //    former per-candidate traverseGraph (an N+1: up to ~100 candidates ×
      //    anchor re-fetch + per-neighbor point queries) with ~2 queries, and
      //    dedups shared neighbors for free.
      const { nodes: neighbors, edges } = expandNeighborhood(stateTree, [...allNodes.keys()]);
      for (const n of neighbors) if (!allNodes.has(n.id)) allNodes.set(n.id, n);
      for (const e of edges) allEdges.set(e.id, e);

      const nodes = [...allNodes.values()];
      // maxPerType: same diversity cap service.getContext applies, so one
      // over-represented type can't crowd out the agent-facing recall block.
      const context = buildContext(nodes, [...allEdges.values()], {
        maxTokens: max_tokens,
        maxPerType: CONTEXT_MAX_PER_TYPE,
      });
      cache.setContext(cacheKey, context, nodes.map(n => n.id));

      return { content: [{ type: 'text' as const, text: context }] };
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
 * FTS5-backed keyword search with a JS linear-scan fallback for inputs FTS5
 * can't parse. Uses the same sanitizer as service.searchNodes so the MCP and
 * CLI/REST keyword branches behave identically (quoted phrases preserved,
 * plain tokens prefix-matched and OR-joined).
 */
function searchByKeywords(stateTree: StateTree, topic: string, limit: number): Node[] {
  const sanitized = sanitizeFtsQuery(topic);
  if (!sanitized) return [];
  try {
    return stateTree.searchFts(sanitized, limit);
  } catch {
    const keywords = topic.toLowerCase().split(/\s+/).filter(Boolean);
    const results: Node[] = [];
    for (const node of stateTree.searchAllNodes(500)) {
      const hay = [
        node.name, node.type, node.summary ?? '',
        JSON.stringify(node.properties),
      ].join(' ').toLowerCase();
      if (keywords.some(kw => hay.includes(kw))) results.push(node);
    }
    return results.slice(0, limit);
  }
}
