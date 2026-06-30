/**
 * Shared service layer — used by both CLI and REST API (and indirectly by MCP server).
 * Wraps core classes with query operations for human-facing interfaces.
 */
import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import type { Config, ConfigOverrides } from './config/index.js';
import { loadConfig } from './config/index.js';
import { initMainDb, initVecDb, type DatabaseConnection } from './db/index.js';
import { EventLog } from './db/event-log.js';
import { StateTree } from './db/state-tree.js';
import { VectorStore } from './db/vector-store.js';
import { UsageLog } from './db/usage-log.js';
import { EngineCache } from './engine/cache.js';
import { getStateStats, runMaintenance, runHistoryCompaction, type MaintenanceReport } from './engine/maintenance.js';
import { runDedupPass, cosineSimilarity, type DedupPassReport, type Tier2Options } from './engine/dedup-scan.js';
import { expandNeighborhood } from './engine/graph-traversal.js';
import { buildContext, CONTEXT_MAX_PER_TYPE } from './engine/context-builder.js';
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
 * Checkpoint + truncate the WAL so the `-wal` sidecar doesn't accumulate across
 * the process lifetime (the long-running MCP server otherwise leaves a multi-MB
 * WAL until SQLite's auto-checkpoint fires). Best-effort: a busy checkpoint
 * (another connection holding the WAL) or a non-WAL db is non-fatal. Mirrors the
 * pattern already used in cli/backup.ts.
 */
function checkpointWal(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* WAL busy or db not in WAL mode — safe to skip */
  }
}

/** Build a Tier 2 embedding lookup scoped to a namespace. Reads from vecDb
 *  (embeddings metadata + vec_embeddings vector blob live in the same file). */
function makeEmbeddingLookup(
  vecDb: Database.Database,
  namespace: string,
): (nodeId: string) => Float32Array | null {
  let stmt: Database.Statement | null = null;
  try {
    stmt = vecDb.prepare(
      "SELECT v.embedding FROM vec_embeddings v " +
      "INNER JOIN embeddings e ON e.id = v.id " +
      "WHERE e.source_type = 'node' AND e.source_id = ? AND e.namespace = ?"
    );
  } catch {
    // vec_embeddings table doesn't exist (sqlite-vec not loaded) — callers
    // get a no-op lookup and Tier 2 becomes a no-op.
    return () => null;
  }
  return (nodeId) => {
    try {
      const row = stmt!.get(nodeId, namespace) as { embedding: Buffer } | undefined;
      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    } catch {
      return null;
    }
  };
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
  usageLog: UsageLog;
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
  configOverrides: ConfigOverrides = {},
  options: CreateCoreOptions = {},
): EngramCore {
  const config = loadConfig(configOverrides);
  const mainDb = initMainDb(config);
  const vecDb = initVecDb(config);

  const ns = config.namespace;
  const eventLog = new EventLog(mainDb.db, ns);
  const stateTree = new StateTree(mainDb.db, eventLog, ns, config.maintenance.historyKeepVersions);
  const embeddingProvider = resolveEmbeddingProvider(config, options.embeddingProvider);

  // BUG-A fix: Pass dimension from provider or config
  const dim = embeddingProvider?.dimension ?? config.embedding.dimension;
  const vectorStore = new VectorStore(vecDb.db, dim, ns);
  const cache = new EngineCache(config.cache);
  const usageLog = new UsageLog(mainDb.db);

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

        // ── Post-hoc Tier 2 semantic dedup ──
        // Opt-in: only runs when config.dedup.semanticAutoMerge is true.
        // For each node we just embedded, ask the vector index for its
        // nearest same-source-type neighbors. Filter by entity type (so
        // 'concept' doesn't merge into 'preference'), verify cosine ≥
        // threshold against the stored vector (the L2 distance returned
        // by sqlite-vec is monotonic w.r.t. cosine on normalized vectors
        // but we compute cosine explicitly so normalization isn't assumed),
        // and if it clears, mergeNodes() to consolidate. This is eventual-
        // consistency — mutate() has already returned by the time we run.
        if (config.dedup.semanticAutoMerge) {
          const getEmb = makeEmbeddingLookup(vecDb.db, ns);
          const threshold = config.dedup.semanticThreshold;
          for (const p of pending) {
            const myNode = stateTree.getNode(p.nodeId);
            if (!myNode || myNode.archived) continue;
            const myEmb = getEmb(p.nodeId);
            if (!myEmb) continue;
            const candidates = vectorStore.search({
              embedding: myEmb,
              sourceType: 'node',
              limit: 5,
            });
            for (const cand of candidates) {
              if (cand.source_id === p.nodeId) continue;
              const other = stateTree.getNode(cand.source_id);
              if (!other || other.archived || other.type !== myNode.type) continue;
              const otherEmb = getEmb(other.id);
              if (!otherEmb) continue;
              const cos = cosineSimilarity(myEmb, otherEmb);
              if (cos < threshold) continue;

              // Canonical: higher confidence wins; tiebreak on older created_at.
              const pickOther =
                other.confidence > myNode.confidence
                || (other.confidence === myNode.confidence
                  && (other.created_at ?? '') <= (myNode.created_at ?? ''));
              const keep = pickOther ? other : myNode;
              const discard = keep.id === other.id ? myNode : other;
              try {
                stateTree.mergeNodes(discard.id, keep.id);
                log.info('post-hoc Tier 2 semantic merge', {
                  namespace: ns,
                  discarded: discard.id,
                  kept: keep.id,
                  cosine: cos,
                });
              } catch (err) {
                log.warn('post-hoc Tier 2 merge failed', {
                  namespace: ns,
                  error: String(err),
                });
              }
              break; // one merge per just-inserted node per callback pass
            }
          }
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
    usageLog,
    close() {
      checkpointWal(mainDb.db);
      checkpointWal(vecDb.db);
      mainDb.close();
      vecDb.close();
    },
    async closeAsync() {
      await stateTree.drainCallbacks();
      checkpointWal(mainDb.db);
      checkpointWal(vecDb.db);
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
export function sanitizeFtsQuery(input: string): string {
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

  // Candidate gathering — accumulate anchor nodes from every active strategy,
  // then expand ONCE (below). Previously each candidate was expanded inline via
  // a per-node depth-1 traversal (an N+1 hot spot); now expansion is batched.

  // Direct entity resolution
  if (opts.entities) {
    for (const entity of opts.entities) {
      const node = core.stateTree.getNode(entity)
        ?? core.stateTree.getNodeByName(entity);
      if (node) allNodes.set(node.id, node);
    }
  }

  // Graph keyword search
  if (opts.topic && (strategy === 'graph' || strategy === 'hybrid')) {
    for (const node of searchNodes(core, opts.topic, 20)) {
      allNodes.set(node.id, node);
    }
  }

  // Semantic vector search
  if (opts.topic && (strategy === 'semantic' || strategy === 'hybrid')) {
    try {
      for (const node of await semanticSearch(core, opts.topic, 10)) {
        allNodes.set(node.id, node);
      }
    } catch {
      // Semantic search failed — fall back to graph results only
    }
  }

  if (allNodes.size === 0) {
    metrics.contextDuration.observe({ namespace: safeNamespaceLabel(core.config.namespace), strategy }, stopTimer());
    return 'No relevant context found.';
  }

  // Single batched depth-1 expansion over all candidates (replaces the former
  // per-candidate traverseGraph N+1; dedups shared neighbors for free).
  const { nodes: neighbors, edges } = expandNeighborhood(core.stateTree, [...allNodes.keys()]);
  for (const n of neighbors) if (!allNodes.has(n.id)) allNodes.set(n.id, n);
  for (const e of edges) allEdges.set(e.id, e);

  const out = buildContext(
    [...allNodes.values()],
    [...allEdges.values()],
    // Cap per-type injection so a project with many near-duplicate decisions
    // can't dominate the SessionStart/UserPromptSubmit recall block — keep the
    // top-N highest-confidence of each type for a diverse, bounded context.
    { maxTokens: opts.maxTokens ?? 2000, maxPerType: CONTEXT_MAX_PER_TYPE },
  );
  metrics.contextDuration.observe({ namespace: safeNamespaceLabel(core.config.namespace), strategy }, stopTimer());
  return out;
}

// ─── Maintenance ─────────────────────────────────────────

export interface MaintenanceCycleReport extends MaintenanceReport, StatusInfo {
  dedup?: DedupPassReport;
  historyCompacted?: number;
  warnings?: string[];
}

export function runMaintenanceCycle(
  core: EngramCore,
  dryRun: boolean = false,
  opts: { dedup?: boolean; semantic?: boolean; compactHistory?: boolean } = {},
): MaintenanceCycleReport {
  const ns = core.config.namespace;
  const statsBefore = getStatus(core);
  const warnings: string[] = [];

  // Build Tier 2 options if the caller asked for semantic dedup AND an
  // embedding provider is configured (otherwise getEmbedding would always
  // return null — expensive no-op).
  let tier2: Tier2Options | undefined;
  if (opts.dedup && opts.semantic) {
    if (core.embeddingProvider && core.vectorStore.isVecEnabled) {
      tier2 = {
        getEmbedding: makeEmbeddingLookup(core.vecDb.db, ns),
        threshold: core.config.dedup.semanticThreshold,
      };
    } else {
      // Surface the silent no-op: --semantic does nothing without embeddings.
      warnings.push(
        'Semantic dedup (--semantic) was requested but no embedding provider is ' +
        'configured (embedding.provider="none"), so Tier 2 cosine matching is inactive — ' +
        'only Tier 1 (name-based) dedup ran. Configure an embedding provider and backfill ' +
        'embeddings to catch semantically-similar duplicates.',
      );
    }
  }

  const keepN = core.config.maintenance.historyKeepVersions;
  const mergeFn = (s: string, t: string) => core.stateTree.mergeNodes(s, t);
  if (opts.compactHistory && keepN <= 0) {
    warnings.push(
      'History compaction was requested but maintenance.historyKeepVersions=0 disables ' +
      'node_history pruning, so no history snapshots were pruned.',
    );
  }

  if (dryRun) {
    const result: MaintenanceCycleReport = {
      decayed: 0, archived: 0, orphansDetected: 0,
      ...statsBefore,
    };
    if (opts.dedup) result.dedup = runDedupPass(core.db, ns, mergeFn, true, tier2);
    if (opts.compactHistory) result.historyCompacted = runHistoryCompaction(core.db, ns, keepN, true).historyPruned;
    if (warnings.length) result.warnings = warnings;
    return result;
  }

  const report = runMaintenance(core.db, ns, core.config.maintenance);
  let dedup: DedupPassReport | undefined;
  if (opts.dedup) dedup = runDedupPass(core.db, ns, mergeFn, false, tier2);
  let historyCompacted: number | undefined;
  if (opts.compactHistory) historyCompacted = runHistoryCompaction(core.db, ns, keepN, false).historyPruned;

  const statsAfter = getStatus(core);
  return {
    ...report,
    ...statsAfter,
    ...(dedup ? { dedup } : {}),
    ...(historyCompacted !== undefined ? { historyCompacted } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
