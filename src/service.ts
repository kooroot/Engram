/**
 * Shared service layer — used by both CLI and REST API (and indirectly by MCP server).
 * Wraps core classes with query operations for human-facing interfaces.
 */
import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import type { Config } from './config/index.js';
import { loadConfig } from './config/index.js';
import { initMainDb, initVecDb, type DatabaseConnection } from './db/index.js';
import { EventLog } from './db/event-log.js';
import { StateTree } from './db/state-tree.js';
import { VectorStore } from './db/vector-store.js';
import { EngineCache } from './engine/cache.js';
import { getStateStats, runMaintenance, type MaintenanceReport } from './engine/maintenance.js';
import { traverseGraph } from './engine/graph-traversal.js';
import { buildContext } from './engine/context-builder.js';
import type { Node, Edge, Event, EventType } from './types/index.js';
import type { EmbeddingProvider } from './embeddings/index.js';
import { OpenAIEmbeddingProvider } from './embeddings/openai.js';
import { LocalEmbeddingProvider } from './embeddings/local.js';
import { ShellEmbeddingProvider } from './embeddings/shell.js';
import { OllamaEmbeddingProvider } from './embeddings/ollama.js';
import { safeJsonParse } from './utils.js';
import { metrics, startTimer, safeNamespaceLabel } from './metrics.js';
import { log } from './logger.js';

export { exportNamespace, importBundle } from './port.js';
export type { ExportBundle, ExportOptions, ImportOptions, ImportResult } from './port.js';

/** Resolve a node by ID or name */
function resolveNode(core: EngramCore, idOrName: string): Node | null {
  return core.stateTree.getNode(idOrName) ?? core.stateTree.getNodeByName(idOrName);
}

/**
 * Merge source into target. Both can be IDs or names.
 * Returns counts of edges re-pointed and deduplicated.
 */
export function mergeNodes(
  core: EngramCore,
  source: string,
  target: string,
): { target_id: string; merged_edges: number; dedup_edges: number } {
  const srcNode = resolveNode(core, source);
  const tgtNode = resolveNode(core, target);
  if (!srcNode) throw new Error(`Source not found: ${source}`);
  if (!tgtNode) throw new Error(`Target not found: ${target}`);
  return core.stateTree.mergeNodes(srcNode.id, tgtNode.id);
}

export interface EngramCore {
  config: Config;
  mainDb: DatabaseConnection;
  vecDb: DatabaseConnection;
  db: Database.Database;
  eventLog: EventLog;
  stateTree: StateTree;
  vectorStore: VectorStore;
  cache: EngineCache;
  embeddingProvider: EmbeddingProvider | null;
  /** Synchronous close — does NOT wait for pending async callbacks */
  close(): void;
  /** Wait for all pending async callbacks (auto-embeds) then close */
  closeAsync(): Promise<void>;
}

export interface CreateCoreOptions {
  embeddingProvider?: EmbeddingProvider;
  disableAutoEmbed?: boolean;
}

/**
 * Resolve embedding provider from config (or override).
 * Auto-detects OpenAI if OPENAI_API_KEY is set and provider is 'none'.
 */
export function resolveEmbeddingProvider(
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
    case 'shell':
      if (!config.embedding.shellCmd) {
        throw new Error(
          "Embedding provider 'shell' requires ENGRAM_EMBEDDING_CMD",
        );
      }
      return new ShellEmbeddingProvider({
        command: config.embedding.shellCmd,
        dimension: config.embedding.dimension,
        timeoutMs: config.embedding.shellTimeoutMs,
      });
    case 'ollama':
      return new OllamaEmbeddingProvider({
        url: config.embedding.ollamaUrl,
        model: config.embedding.ollamaModel,
        dimension: config.embedding.dimension,
      });
    case 'none':
    default:
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

/**
 * Factory used by CLI, REST, and MCP server alike.
 * Handles: DB initialization, embedding provider resolution, sqlite-vec loading,
 * and optional auto-embedding hook registration.
 */
export function createEngramCore(
  configOverrides: Partial<Config> = {},
  options: CreateCoreOptions = {},
): EngramCore {
  const config = loadConfig(configOverrides);
  const mainDb = initMainDb(config);
  const vecDb = initVecDb(config);

  const ns = config.namespace;
  const eventLog = new EventLog(mainDb.db, ns);
  const stateTree = new StateTree(mainDb.db, eventLog, ns);
  const embeddingProvider = resolveEmbeddingProvider(config, options.embeddingProvider);

  // BUG-A fix: Pass dimension from provider or config
  const dim = embeddingProvider?.dimension ?? config.embedding.dimension;
  const vectorStore = new VectorStore(vecDb.db, dim, ns);
  const cache = new EngineCache(config.cache);

  // Enable sqlite-vec (single source of truth; removed duplication from server.ts)
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as { load: (db: any) => void };
    vectorStore.enableVec(sqliteVec.load);
  } catch {
    // sqlite-vec not available — vector search disabled, graph queries still work
  }

  if (embeddingProvider && vectorStore.isVecEnabled && !options.disableAutoEmbed) {
    stateTree.onMutate(async (nodeIds) => {
      // M6: batch embedding requests — one API call per mutation instead of N
      // M7: skip archived/deleted nodes to avoid wasted API calls
      const pending: Array<{ nodeId: string; text: string }> = [];
      for (const nodeId of nodeIds) {
        const node = stateTree.getNode(nodeId);
        if (!node || node.archived) continue;
        const text = node.summary ?? `${node.name} [${node.type}]: ${JSON.stringify(node.properties)}`;
        pending.push({ nodeId, text });
      }
      if (pending.length === 0) return;

      try {
        const embeddings = await embeddingProvider.embedBatch(pending.map(p => p.text));
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i];
          vectorStore.removeBySource('node', p.nodeId);
          vectorStore.store({
            source_type: 'node',
            source_id: p.nodeId,
            text: p.text,
            embedding: embeddings[i],
          });
          metrics.embeddings.inc({ namespace: safeNamespaceLabel(ns) });
        }
      } catch (err) {
        metrics.embeddingFailures.inc({ namespace: safeNamespaceLabel(ns) }, pending.length);
        log.warn('auto-embed batch failed', {
          namespace: ns,
          count: pending.length,
          error: String(err),
        });
      }
    });
  }

  return {
    config,
    mainDb,
    vecDb,
    db: mainDb.db,
    eventLog,
    stateTree,
    vectorStore,
    cache,
    embeddingProvider,
    close() {
      mainDb.close();
      vecDb.close();
    },
    async closeAsync() {
      await stateTree.drainCallbacks();
      mainDb.close();
      vecDb.close();
    },
  };
}

// ─── Status ──────────────────────────────────────────────

export interface StatusInfo {
  activeNodes: number;
  archivedNodes: number;
  activeEdges: number;
  totalEvents: number;
  dataDir: string;
  namespace: string;
  semanticEnabled: boolean;
}

export function getStatus(core: EngramCore): StatusInfo {
  const stats = getStateStats(core.db, core.config.namespace);
  return {
    ...stats,
    dataDir: core.config.dataDir,
    namespace: core.config.namespace,
    semanticEnabled: core.embeddingProvider !== null && core.vectorStore.isVecEnabled,
  };
}

/** List all distinct namespaces that exist in the DB */
export function listNamespaces(core: EngramCore): string[] {
  const rows = core.db
    .prepare('SELECT DISTINCT namespace FROM nodes UNION SELECT DISTINCT namespace FROM events ORDER BY namespace')
    .all() as Array<{ namespace: string }>;
  return rows.map(r => r.namespace);
}

// ─── Nodes ───────────────────────────────────────────────

export function listNodes(
  core: EngramCore,
  opts: { type?: string; limit?: number } = {},
): Node[] {
  const limit = opts.limit ?? 50;
  if (opts.type) {
    return core.stateTree.getNodesByType(opts.type, limit);
  }
  return core.stateTree.searchAllNodes(limit);
}

export interface NodeDetail {
  node: Node;
  outEdges: Edge[];
  inEdges: Edge[];
}

export function getNodeDetail(
  core: EngramCore,
  nameOrId: string,
): NodeDetail | null {
  const node = core.stateTree.getNode(nameOrId)
    ?? core.stateTree.getNodeByName(nameOrId);
  if (!node) return null;

  return {
    node,
    outEdges: core.stateTree.getEdgesFrom(node.id),
    inEdges: core.stateTree.getEdgesTo(node.id),
  };
}

// ─── Edges ───────────────────────────────────────────────

export interface EdgeInfo {
  edge: Edge;
  sourceName: string;
  targetName: string;
}

export function getEdgesForNode(
  core: EngramCore,
  nameOrId: string,
): { node: Node; edges: EdgeInfo[] } | null {
  const node = core.stateTree.getNode(nameOrId)
    ?? core.stateTree.getNodeByName(nameOrId);
  if (!node) return null;

  const outEdges = core.stateTree.getEdgesFrom(node.id);
  const inEdges = core.stateTree.getEdgesTo(node.id);
  const edges: EdgeInfo[] = [];

  for (const e of outEdges) {
    const target = core.stateTree.getNode(e.target_id);
    edges.push({
      edge: e,
      sourceName: node.name,
      targetName: target?.name ?? e.target_id,
    });
  }

  for (const e of inEdges) {
    const source = core.stateTree.getNode(e.source_id);
    edges.push({
      edge: e,
      sourceName: source?.name ?? e.source_id,
      targetName: node.name,
    });
  }

  return { node, edges };
}

// ─── Search ──────────────────────────────────────────────

/**
 * Keyword search via FTS5 (fast, indexed) with fallback to JS filter
 * if FTS5 parsing fails on unusual input.
 */
export function searchNodes(
  core: EngramCore,
  query: string,
  limit: number = 20,
): Node[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    return core.stateTree.searchFts(sanitized, limit);
  } catch {
    return fallbackSearch(core, query, limit);
  }
}

/**
 * Sanitize user input for FTS5. Quoted phrases are preserved as-is;
 * plain tokens are prefix-matched (`engi*` matches engineer/engineering)
 * and joined with OR so any match wins.
 */
function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const out: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(trimmed)) !== null) {
    if (m[1]) {
      out.push(`"${m[1]}"`);
    } else if (m[2]) {
      const cleaned = m[2].replace(/["()\-*:^]/g, '');
      if (cleaned) out.push(`${cleaned}*`);
    }
  }
  return out.join(' OR ');
}

function fallbackSearch(core: EngramCore, query: string, limit: number): Node[] {
  const keywords = query.toLowerCase().split(/\s+/);
  const allActive = core.stateTree.searchAllNodes(500);
  const results: Node[] = [];
  for (const node of allActive) {
    const hay = [
      node.name,
      node.type,
      node.summary ?? '',
      JSON.stringify(node.properties),
    ].join(' ').toLowerCase();
    if (keywords.some(kw => hay.includes(kw))) results.push(node);
  }
  return results.slice(0, limit);
}

/**
 * Semantic search using vector embeddings.
 * Returns [] if embedding provider or sqlite-vec not available.
 */
export async function semanticSearch(
  core: EngramCore,
  query: string,
  limit: number = 5,
): Promise<Node[]> {
  if (!core.embeddingProvider || !core.vectorStore.isVecEnabled) return [];

  const embedding = await core.embeddingProvider.embed(query);
  const vecResults = core.vectorStore.search({
    embedding,
    limit,
    sourceType: 'node',
  });

  const nodes: Node[] = [];
  for (const r of vecResults) {
    const node = core.stateTree.getNode(r.source_id);
    if (node && !node.archived) nodes.push(node);
  }
  return nodes;
}

// ─── Events ──────────────────────────────────────────────

export function listEvents(
  core: EngramCore,
  opts: { limit?: number; type?: EventType } = {},
): Event[] {
  const limit = opts.limit ?? 20;
  if (opts.type) {
    return core.eventLog.queryByType(opts.type, limit);
  }
  return core.eventLog.queryRecent(limit);
}

// ─── History ─────────────────────────────────────────────

export interface HistoryEntry {
  version: number;
  properties: Record<string, unknown>;
  changed_by: number | null;
  timestamp: string;
}

export function getNodeHistory(
  core: EngramCore,
  nameOrId: string,
): { node: Node; history: HistoryEntry[] } | null {
  const node = core.stateTree.getNode(nameOrId)
    ?? core.stateTree.getNodeByName(nameOrId);
  if (!node) return null;

  const rows = core.db
    .prepare('SELECT * FROM node_history WHERE node_id = ? ORDER BY version DESC')
    .all(node.id) as Array<{
      version: number;
      properties: string;
      changed_by: number | null;
      timestamp: string;
    }>;

  const history: HistoryEntry[] = rows.map(r => ({
    version: r.version,
    properties: safeJsonParse(r.properties),
    changed_by: r.changed_by,
    timestamp: r.timestamp,
  }));

  return { node, history };
}

// ─── Context ─────────────────────────────────────────────

export type ContextStrategy = 'graph' | 'semantic' | 'hybrid';

/**
 * BUG-C fix: Now supports semantic/hybrid strategy via embedding + vector store.
 */
export async function getContext(
  core: EngramCore,
  opts: {
    topic?: string;
    entities?: string[];
    maxTokens?: number;
    strategy?: ContextStrategy;
  },
): Promise<string> {
  const strategy: ContextStrategy = opts.strategy ?? 'hybrid';
  const stopTimer = startTimer();
  metrics.contextRequests.inc({ namespace: safeNamespaceLabel(core.config.namespace), strategy });
  const allNodes = new Map<string, Node>();
  const allEdges = new Map<string, Edge>();

  // Direct entity resolution
  if (opts.entities) {
    for (const entity of opts.entities) {
      const node = core.stateTree.getNode(entity)
        ?? core.stateTree.getNodeByName(entity);
      if (node) {
        allNodes.set(node.id, node);
        expand(core, node.id, allNodes, allEdges);
      }
    }
  }

  // Graph keyword search
  if (opts.topic && (strategy === 'graph' || strategy === 'hybrid')) {
    const candidates = searchNodes(core, opts.topic, 20);
    for (const node of candidates) {
      allNodes.set(node.id, node);
      expand(core, node.id, allNodes, allEdges);
    }
  }

  // Semantic vector search
  if (opts.topic && (strategy === 'semantic' || strategy === 'hybrid')) {
    try {
      const semantic = await semanticSearch(core, opts.topic, 10);
      for (const node of semantic) {
        allNodes.set(node.id, node);
        expand(core, node.id, allNodes, allEdges);
      }
    } catch {
      // Semantic search failed — fall back to graph results only
    }
  }

  if (allNodes.size === 0) {
    metrics.contextDuration.observe({ namespace: safeNamespaceLabel(core.config.namespace), strategy }, stopTimer());
    return 'No relevant context found.';
  }

  const out = buildContext(
    [...allNodes.values()],
    [...allEdges.values()],
    { maxTokens: opts.maxTokens ?? 2000 },
  );
  metrics.contextDuration.observe({ namespace: safeNamespaceLabel(core.config.namespace), strategy }, stopTimer());
  return out;
}

function expand(
  core: EngramCore,
  nodeId: string,
  allNodes: Map<string, Node>,
  allEdges: Map<string, Edge>,
): void {
  const result = traverseGraph(core.stateTree, {
    from: nodeId,
    direction: 'both',
    depth: 1,
  });
  for (const n of result.nodes) allNodes.set(n.id, n);
  for (const e of result.edges) allEdges.set(e.id, e);
}

// ─── Maintenance ─────────────────────────────────────────

export function runMaintenanceCycle(
  core: EngramCore,
  dryRun: boolean = false,
): MaintenanceReport & StatusInfo {
  const statsBefore = getStatus(core);

  if (dryRun) {
    return { decayed: 0, archived: 0, orphansDetected: 0, ...statsBefore };
  }

  const report = runMaintenance(core.db, core.config.namespace, core.config.maintenance);
  const statsAfter = getStatus(core);
  return { ...report, ...statsAfter };
}
