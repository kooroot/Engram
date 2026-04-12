import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventLog } from '../db/event-log.js';
import type { StateTree } from '../db/state-tree.js';
import type { VectorStore } from '../db/vector-store.js';
import type { EngineCache } from '../engine/cache.js';
import type { EmbeddingProvider } from '../embeddings/index.js';

import { registerLogEvent } from './log-event.js';
import { registerMutateState } from './mutate-state.js';
import { registerLinkEntities } from './link-entities.js';
import { registerQueryEngram } from './query-engram.js';
import { registerSearchMemory } from './search-memory.js';
import { registerGetContext } from './get-context.js';

export function registerAllTools(
  server: McpServer,
  eventLog: EventLog,
  stateTree: StateTree,
  vectorStore: VectorStore,
  cache: EngineCache,
  embeddingProvider: EmbeddingProvider | null,
): void {
  registerLogEvent(server, eventLog);
  registerMutateState(server, stateTree);
  registerLinkEntities(server, stateTree);
  registerQueryEngram(server, stateTree);
  registerSearchMemory(server, vectorStore, embeddingProvider);
  registerGetContext(server, stateTree, vectorStore, cache, embeddingProvider);
}
