import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { VectorStore } from '../db/vector-store.js';
import type { Node, Edge } from '../types/index.js';
import { traverseGraph } from '../engine/graph-traversal.js';
import { buildContext } from '../engine/context-builder.js';
import type { EngineCache } from '../engine/cache.js';
import type { EmbeddingProvider } from '../embeddings/index.js';

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

      // 1. Direct entity resolution
      if (entities && entities.length > 0) {
        for (const entity of entities) {
          const node = stateTree.getNode(entity) ?? stateTree.getNodeByName(entity);
          if (node) {
            allNodes.set(node.id, node);
            expandFromNode(stateTree, node.id, allNodes, allEdges);
          }
        }
      }

      // 2. Graph-based keyword search (H1: search ALL node types, not hardcoded list)
      if (topic && (strategy === 'graph' || strategy === 'hybrid')) {
        const keywords = topic.toLowerCase().split(/\s+/);
        const candidates = findNodesByKeywords(stateTree, keywords);
        for (const node of candidates) {
          allNodes.set(node.id, node);
          expandFromNode(stateTree, node.id, allNodes, allEdges);
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
              if (node && !node.archived) {
                allNodes.set(node.id, node);
                expandFromNode(stateTree, node.id, allNodes, allEdges);
              }
            }
          } catch {
            // Embedding failed — fall back to graph results only
          }
        }
      }

      const nodes = [...allNodes.values()];
      const edges = [...allEdges.values()];

      if (nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No relevant context found in memory.',
          }],
        };
      }

      const context = buildContext(nodes, edges, { maxTokens: max_tokens });
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

function expandFromNode(
  stateTree: StateTree,
  nodeId: string,
  allNodes: Map<string, Node>,
  allEdges: Map<string, Edge>,
): void {
  const result = traverseGraph(stateTree, {
    from: nodeId,
    direction: 'both',
    depth: 1,
  });
  for (const n of result.nodes) allNodes.set(n.id, n);
  for (const e of result.edges) allEdges.set(e.id, e);
}

/**
 * Fast FTS5-backed keyword search (with JS fallback).
 */
function findNodesByKeywords(stateTree: StateTree, keywords: string[]): Node[] {
  if (keywords.length === 0) return [];

  // Build FTS5 OR query with prefix match per keyword
  const sanitized = keywords
    .map(kw => kw.replace(/["()\-*:^]/g, ''))
    .filter(Boolean)
    .map(kw => `${kw}*`)
    .join(' OR ');

  if (!sanitized) return [];

  try {
    return stateTree.searchFts(sanitized, 100);
  } catch {
    // Fallback: linear scan
    const allActive = stateTree.searchAllNodes(500);
    const results: Node[] = [];
    for (const node of allActive) {
      const hay = [
        node.name, node.type, node.summary ?? '',
        JSON.stringify(node.properties),
      ].join(' ').toLowerCase();
      if (keywords.some(kw => hay.includes(kw))) results.push(node);
    }
    return results;
  }
}
