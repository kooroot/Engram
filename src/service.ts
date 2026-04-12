/**
 * Shared service layer — used by both CLI and REST API.
 * Wraps core classes with query operations for human-facing interfaces.
 */
import type Database from 'better-sqlite3';
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
import { safeJsonParse } from './utils.js';

export interface EngramCore {
  config: Config;
  mainDb: DatabaseConnection;
  vecDb: DatabaseConnection;
  db: Database.Database;
  eventLog: EventLog;
  stateTree: StateTree;
  vectorStore: VectorStore;
  cache: EngineCache;
  close(): void;
}

export function createEngramCore(configOverrides: Partial<Config> = {}): EngramCore {
  const config = loadConfig(configOverrides);
  const mainDb = initMainDb(config);
  const vecDb = initVecDb(config);

  const eventLog = new EventLog(mainDb.db);
  const stateTree = new StateTree(mainDb.db, eventLog);
  const vectorStore = new VectorStore(vecDb.db);
  const cache = new EngineCache(config.cache);

  return {
    config,
    mainDb,
    vecDb,
    db: mainDb.db,
    eventLog,
    stateTree,
    vectorStore,
    cache,
    close() {
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
}

export function getStatus(core: EngramCore): StatusInfo {
  const stats = getStateStats(core.db);
  return {
    ...stats,
    dataDir: core.config.dataDir,
  };
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

export function searchNodes(
  core: EngramCore,
  query: string,
  limit: number = 20,
): Node[] {
  const keywords = query.toLowerCase().split(/\s+/);
  const allActive = core.stateTree.searchAllNodes(500);
  const results: Node[] = [];

  for (const node of allActive) {
    const nameLower = node.name.toLowerCase();
    const summaryLower = (node.summary ?? '').toLowerCase();
    const propsStr = JSON.stringify(node.properties).toLowerCase();

    if (keywords.some(kw =>
      nameLower.includes(kw) || summaryLower.includes(kw) || propsStr.includes(kw)
    )) {
      results.push(node);
    }
  }

  return results.slice(0, limit);
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

export function getContext(
  core: EngramCore,
  opts: { topic?: string; entities?: string[]; maxTokens?: number },
): string {
  const allNodes = new Map<string, Node>();
  const allEdges = new Map<string, Edge>();

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

  if (opts.topic) {
    const keywords = opts.topic.toLowerCase().split(/\s+/);
    const candidates = searchNodes(core, opts.topic, 20);
    for (const node of candidates) {
      allNodes.set(node.id, node);
      expand(core, node.id, allNodes, allEdges);
    }
  }

  if (allNodes.size === 0) return 'No relevant context found.';

  return buildContext(
    [...allNodes.values()],
    [...allEdges.values()],
    { maxTokens: opts.maxTokens ?? 2000 },
  );
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

  const report = runMaintenance(core.db, core.config.maintenance);
  const statsAfter = getStatus(core);
  return { ...report, ...statsAfter };
}

