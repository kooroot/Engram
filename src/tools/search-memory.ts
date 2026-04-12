import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../db/vector-store.js';
import type { EmbeddingProvider } from '../embeddings/index.js';

export function registerSearchMemory(
  server: McpServer,
  vectorStore: VectorStore,
  embeddingProvider: EmbeddingProvider | null,
): void {
  server.registerTool('search_memory', {
    description: 'Semantic vector search across memory. Returns results ranked by similarity.',
    inputSchema: {
      query: z.string().describe('Natural language search query'),
      source_type: z.enum(['node', 'event', 'edge_context', 'all']).default('all'),
      limit: z.number().min(1).max(20).default(5),
      min_similarity: z.number().min(0).max(1).default(0.7),
    },
  }, async ({ query, source_type, limit, min_similarity }) => {
    if (!embeddingProvider) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: [],
            message: 'Embedding provider not configured. Set OPENAI_API_KEY or provide a custom provider.',
          }),
        }],
      };
    }

    if (!vectorStore.isVecEnabled) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: [],
            message: 'sqlite-vec extension not available. Vector search is disabled.',
          }),
        }],
      };
    }

    try {
      const embedding = await embeddingProvider.embed(query);
      const results = vectorStore.search({
        embedding,
        limit,
        sourceType: source_type,
      });

      // Filter by similarity threshold (distance-based: lower = more similar)
      // Convert distance to similarity: similarity = 1 / (1 + distance)
      const filtered = results
        .map(r => ({
          ...r,
          similarity: 1 / (1 + r.distance),
        }))
        .filter(r => r.similarity >= min_similarity);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ results: filtered }),
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
