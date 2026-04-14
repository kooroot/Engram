import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config/index.js';
import { createEngramCore, type EngramCore } from './service.js';
import { registerAllTools } from './tools/index.js';
import type { EmbeddingProvider } from './embeddings/index.js';

export interface EngramServer {
  mcpServer: McpServer;
  core: EngramCore;
  // Direct access for tests and advanced integration (forwards from core)
  eventLog: EngramCore['eventLog'];
  stateTree: EngramCore['stateTree'];
  vectorStore: EngramCore['vectorStore'];
  cache: EngramCore['cache'];
  embeddingProvider: EngramCore['embeddingProvider'];
  close(): void;
}

export interface CreateServerOptions {
  embeddingProvider?: EmbeddingProvider;
}

export function createEngramServer(
  config: Config,
  options: CreateServerOptions = {},
): EngramServer {
  // Reuse the shared core factory — embedding, vec, auto-embed hook all handled there
  const core = createEngramCore(config, { embeddingProvider: options.embeddingProvider });
  const hasSemanticSearch = core.embeddingProvider !== null && core.vectorStore.isVecEnabled;

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

  registerAllTools(
    mcpServer,
    core.eventLog,
    core.stateTree,
    core.vectorStore,
    core.cache,
    core.embeddingProvider,
  );

  return {
    mcpServer,
    core,
    eventLog: core.eventLog,
    stateTree: core.stateTree,
    vectorStore: core.vectorStore,
    cache: core.cache,
    embeddingProvider: core.embeddingProvider,
    close() {
      core.close();
    },
  };
}
