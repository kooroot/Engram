import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config/index.js';
import { initMainDb, initVecDb } from './db/index.js';
import { EventLog } from './db/event-log.js';
import { StateTree } from './db/state-tree.js';
import { VectorStore } from './db/vector-store.js';
import { EngineCache } from './engine/cache.js';
import { registerAllTools } from './tools/index.js';
import type { EmbeddingProvider } from './embeddings/index.js';
import { OpenAIEmbeddingProvider } from './embeddings/openai.js';
import { LocalEmbeddingProvider } from './embeddings/local.js';

export interface EngramServer {
  mcpServer: McpServer;
  eventLog: EventLog;
  stateTree: StateTree;
  vectorStore: VectorStore;
  cache: EngineCache;
  embeddingProvider: EmbeddingProvider | null;
  close(): void;
}

export interface CreateServerOptions {
  embeddingProvider?: EmbeddingProvider;
}

function resolveEmbeddingProvider(
  config: Config,
  override?: EmbeddingProvider,
): EmbeddingProvider | null {
  if (override) return override;

  switch (config.embedding.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        apiKey: config.embedding.apiKey,
        model: config.embedding.model,
        dimension: config.embedding.dimension,
        baseUrl: config.embedding.baseUrl,
      });
    case 'local':
      return new LocalEmbeddingProvider(config.embedding.dimension);
    case 'none':
    default:
      // Auto-detect: if OPENAI_API_KEY is set, use OpenAI
      if (config.embedding.apiKey) {
        return new OpenAIEmbeddingProvider({
          apiKey: config.embedding.apiKey,
          model: config.embedding.model,
          dimension: config.embedding.dimension,
          baseUrl: config.embedding.baseUrl,
        });
      }
      return null;
  }
}

export function createEngramServer(
  config: Config,
  options: CreateServerOptions = {},
): EngramServer {
  const mainDb = initMainDb(config);
  const vecDb = initVecDb(config);

  const eventLog = new EventLog(mainDb.db);
  const stateTree = new StateTree(mainDb.db, eventLog);
  const embeddingProvider = resolveEmbeddingProvider(config, options.embeddingProvider);
  const vectorStore = new VectorStore(vecDb.db, embeddingProvider?.dimension ?? config.embedding.dimension);
  const cache = new EngineCache(config.cache);

  // C1 fix: Use createRequire for ESM compatibility with native addons
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as { load: (db: any) => void };
    vectorStore.enableVec(sqliteVec.load);
  } catch {
    // sqlite-vec not available — vector search disabled, graph queries still work
  }

  const hasSemanticSearch = embeddingProvider !== null && vectorStore.isVecEnabled;

  const mcpServer = new McpServer(
    {
      name: 'engram',
      version: '0.1.0',
    },
    {
      instructions: `You are connected to Engram, an AI-native persistent memory system.

## Available Tools

- **mutate_state**: Create, update, or delete entities (nodes) in the knowledge graph.
- **link_entities**: Create, modify, or remove relationships (edges) between entities.
- **query_engram**: Look up specific entities or traverse the knowledge graph.
- **get_context**: Fetch relevant context for a topic — use this to recall memories before responding.
- **log_event**: Record observations, actions, or events to the immutable event log.
- **search_memory**: Semantic search across memory${hasSemanticSearch ? '' : ' (requires OPENAI_API_KEY)'}.

## How to Use

1. **Before responding**: Call \`get_context\` with the user's topic to recall relevant knowledge.
2. **When learning new facts**: Use \`mutate_state\` to create or update entities.
3. **When learning relationships**: Use \`link_entities\` to connect entities.
4. **For audit trail**: Use \`log_event\` to record important observations.

## Principles

- Prefer updating existing nodes over creating duplicates.
- Use short, standardized predicates for edges: works_on, knows, is_a, prefers, located_in, etc.
- Include a \`summary\` field when creating nodes — it optimizes future context injection.
- Set \`confidence\` below 1.0 for uncertain facts.`,
    },
  );

  registerAllTools(mcpServer, eventLog, stateTree, vectorStore, cache, embeddingProvider);

  // Auto-embed nodes on mutation (if embedding provider available)
  if (embeddingProvider && vectorStore.isVecEnabled) {
    stateTree.onMutate(async (nodeIds) => {
      for (const nodeId of nodeIds) {
        const node = stateTree.getNode(nodeId);
        if (!node) continue; // deleted

        const text = node.summary ?? `${node.name} [${node.type}]: ${JSON.stringify(node.properties)}`;
        try {
          const embedding = await embeddingProvider.embed(text);
          vectorStore.removeBySource('node', nodeId);
          vectorStore.store({ source_type: 'node', source_id: nodeId, text, embedding });
        } catch {
          // Embedding failure is non-fatal
        }
      }
    });
  }

  return {
    mcpServer,
    eventLog,
    stateTree,
    vectorStore,
    cache,
    embeddingProvider,
    close() {
      mainDb.close();
      vecDb.close();
    },
  };
}
