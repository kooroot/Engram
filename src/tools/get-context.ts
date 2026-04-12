import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateTree } from '../db/state-tree.js';
import type { VectorStore } from '../db/vector-store.js';
import type { Node } from '../types/index.js';
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
    description: 'Fetch relevant context from the memory graph for injection into the LLM prompt. This is the primary read-path tool — use it to recall what you know about a topic or set of entities.',
    inputSchema: {
      topic: z.string().optional().describe('Natural language topic to find context for'),
      entities: z.array(z.string()).optional().describe('Known entity names or IDs to include'),
      max_tokens: z.number().default(2000).describe('Token budget for the response'),
      strategy: z.enum(['graph', 'semantic', 'hybrid']).default('hybrid')
        .describe('Search strategy: graph (fast, structured), semantic (fuzzy), hybrid (both)'),
    },
  }, async ({ topic, entities, max_tokens, strategy }) => {
    try {
      // Check cache
      const cacheKey = createHash('md5')
        .update(JSON.stringify({ topic, entities, max_tokens, strategy }))
        .digest('hex');

      const cached = cache.getContext(cacheKey);
      if (cached) {
        return { content: [{ type: 'text' as const, text: cached }] };
      }

      const allNodes = new Map<string, Node>();
      const allEdges = new Map<string, any>();

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

      // 2. Graph-based search (keyword matching on node names/summaries/properties)
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

      // Cache the result
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

/** Expand 1-hop from a node and collect into maps */
function expandFromNode(
  stateTree: StateTree,
  nodeId: string,
  allNodes: Map<string, Node>,
  allEdges: Map<string, any>,
): void {
  const result = traverseGraph(stateTree, {
    from: nodeId,
    direction: 'both',
    depth: 1,
  });
  for (const n of result.nodes) allNodes.set(n.id, n);
  for (const e of result.edges) allEdges.set(e.id, e);
}

/** Simple keyword search across node names, summaries, and properties */
function findNodesByKeywords(stateTree: StateTree, keywords: string[]): Node[] {
  const types = ['person', 'project', 'concept', 'rule', 'fact'];
  const results: Node[] = [];

  for (const type of types) {
    const nodes = stateTree.getNodesByType(type, 100);
    for (const node of nodes) {
      const nameLower = node.name.toLowerCase();
      const summaryLower = (node.summary ?? '').toLowerCase();
      const propsStr = JSON.stringify(node.properties).toLowerCase();

      if (keywords.some(kw =>
        nameLower.includes(kw) || summaryLower.includes(kw) || propsStr.includes(kw)
      )) {
        results.push(node);
      }
    }
  }

  return results;
}
