import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventLog } from '../db/event-log.js';
import type { StateTree } from '../db/state-tree.js';
import type { VectorStore } from '../db/vector-store.js';
import type { EngineCache } from '../engine/cache.js';
import type { EmbeddingProvider } from '../embeddings/index.js';
import type { UsageLog } from '../db/usage-log.js';
import { withUsageTracking } from '../db/usage-log.js';

import { registerLogEvent } from './log-event.js';
import { registerMutateState } from './mutate-state.js';
import { registerLinkEntities } from './link-entities.js';
import { registerQueryEngram } from './query-engram.js';
import { registerSearchMemory } from './search-memory.js';
import { registerGetContext } from './get-context.js';
import { registerMergeNodes } from './merge-nodes.js';

export interface UsageTrackingOptions {
  usageLog: UsageLog;
  namespace: string;
}

export function registerAllTools(
  server: McpServer,
  eventLog: EventLog,
  stateTree: StateTree,
  vectorStore: VectorStore,
  cache: EngineCache,
  embeddingProvider: EmbeddingProvider | null,
  tracking?: UsageTrackingOptions,
): void {
  // Wrap server with a Proxy so every registerTool() call gets timing + token recording.
  // Tool implementations themselves are unchanged.
  const target = tracking
    ? withUsageTracking(server, rec => tracking.usageLog.record(rec), tracking.namespace)
    : server;

  registerLogEvent(target, eventLog);
  registerMutateState(target, stateTree, cache);
  registerLinkEntities(target, stateTree, cache);
  registerQueryEngram(target, stateTree);
  registerSearchMemory(target, vectorStore, embeddingProvider);
  registerGetContext(target, stateTree, vectorStore, cache, embeddingProvider);
  registerMergeNodes(target, stateTree, cache);
}
