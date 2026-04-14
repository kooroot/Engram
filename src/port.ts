/**
 * Import/Export for namespace-scoped memory.
 *
 * JSON format:
 * {
 *   version: 1,
 *   namespace: string,
 *   exported_at: ISO timestamp,
 *   nodes:  Node[]   (includes archived unless excludeArchived)
 *   edges:  Edge[]
 *   events: Event[]
 *   history: HistoryEntry[]
 * }
 */
import type { EngramCore } from './service.js';
import { ulid } from 'ulid';
import type { Node, Edge, Event } from './types/index.js';
import { nodeFromRow, edgeFromRow, eventFromRow } from './types/index.js';
import type { NodeRow, EdgeRow, EventRow } from './types/index.js';
import { safeJsonParse } from './utils.js';

export const EXPORT_VERSION = 1;

export interface ExportBundle {
  version: number;
  namespace: string;
  exported_at: string;
  nodes: Node[];
  edges: Edge[];
  events: Event[];
  history: Array<{
    node_id: string;
    version: number;
    properties: Record<string, unknown>;
    changed_by: number | null;
    timestamp: string;
  }>;
}

export interface ExportOptions {
  includeArchived?: boolean;
  includeEvents?: boolean;
  includeHistory?: boolean;
}

export function exportNamespace(core: EngramCore, opts: ExportOptions = {}): ExportBundle {
  const ns = core.config.namespace;
  const includeArchived = opts.includeArchived ?? true;
  const includeEvents = opts.includeEvents ?? true;
  const includeHistory = opts.includeHistory ?? true;

  const nodeRows = core.db
    .prepare(
      includeArchived
        ? 'SELECT * FROM nodes WHERE namespace = ? ORDER BY created_at'
        : 'SELECT * FROM nodes WHERE namespace = ? AND archived = 0 ORDER BY created_at'
    )
    .all(ns) as NodeRow[];

  const edgeRows = core.db
    .prepare(
      includeArchived
        ? 'SELECT * FROM edges WHERE namespace = ? ORDER BY created_at'
        : 'SELECT * FROM edges WHERE namespace = ? AND archived = 0 ORDER BY created_at'
    )
    .all(ns) as EdgeRow[];

  const eventRows = includeEvents
    ? (core.db
        .prepare('SELECT * FROM events WHERE namespace = ? ORDER BY id')
        .all(ns) as EventRow[])
    : [];

  const historyRows = includeHistory
    ? (core.db
        .prepare('SELECT * FROM node_history WHERE namespace = ? ORDER BY node_id, version')
        .all(ns) as Array<{
          node_id: string;
          version: number;
          properties: string;
          changed_by: number | null;
          timestamp: string;
        }>)
    : [];

  return {
    version: EXPORT_VERSION,
    namespace: ns,
    exported_at: new Date().toISOString(),
    nodes: nodeRows.map(nodeFromRow),
    edges: edgeRows.map(edgeFromRow),
    events: eventRows.map(eventFromRow),
    history: historyRows.map(r => ({
      node_id: r.node_id,
      version: r.version,
      properties: safeJsonParse(r.properties),
      changed_by: r.changed_by,
      timestamp: r.timestamp,
    })),
  };
}

export interface ImportOptions {
  /** Namespace to import into. If omitted, uses bundle.namespace. */
  targetNamespace?: string;
  /** Strategy when a node with same ID already exists:
   *  - 'skip' (default): leave existing node, skip imported
   *  - 'overwrite': replace existing with imported
   *  - 'merge': keep higher version, merge properties
   *  - 'reassign': generate new IDs for all imported nodes (preserve structure)
   */
  conflictStrategy?: 'skip' | 'overwrite' | 'merge' | 'reassign';
}

export interface ImportResult {
  importedNodes: number;
  importedEdges: number;
  importedEvents: number;
  skipped: number;
  renamed: number;
  targetNamespace: string;
}

/**
 * Import a previously-exported bundle into a namespace.
 * Does NOT regenerate event log chain — imported events keep their checksums
 * as historical record (chain validity only enforced for newly-created events).
 */
export function importBundle(
  core: EngramCore,
  bundle: ExportBundle,
  opts: ImportOptions = {},
): ImportResult {
  if (bundle.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${bundle.version} (expected ${EXPORT_VERSION})`);
  }

  const targetNs = opts.targetNamespace ?? bundle.namespace;
  const strategy = opts.conflictStrategy ?? 'skip';
  if (!/^[a-zA-Z0-9_\-.]+$/.test(targetNs)) {
    throw new Error(`Invalid target namespace format: ${targetNs}`);
  }

  const result: ImportResult = {
    importedNodes: 0,
    importedEdges: 0,
    importedEvents: 0,
    skipped: 0,
    renamed: 0,
    targetNamespace: targetNs,
  };

  // ID remapping for reassign strategy
  const idMap = new Map<string, string>();

  const insertNode = core.db.prepare(`
    INSERT OR IGNORE INTO nodes
      (id, type, name, properties, summary, confidence, created_at, updated_at, version, archived, event_id, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const replaceNode = core.db.prepare(`
    INSERT OR REPLACE INTO nodes
      (id, type, name, properties, summary, confidence, created_at, updated_at, version, archived, event_id, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const existsNode = core.db.prepare(
    'SELECT version FROM nodes WHERE id = ? AND namespace = ?'
  );
  // C-A1: detect cross-namespace collision before any write
  const findNodeAnywhere = core.db.prepare(
    'SELECT namespace FROM nodes WHERE id = ?'
  );
  const insertEdge = core.db.prepare(`
    INSERT OR IGNORE INTO edges
      (id, source_id, predicate, target_id, properties, confidence, created_at, updated_at, version, archived, event_id, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = core.db.prepare(`
    INSERT INTO events
      (timestamp, type, source, session_id, content, state_ref, checksum, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHistory = core.db.prepare(`
    INSERT INTO node_history (node_id, version, properties, changed_by, namespace, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const txn = core.db.transaction(() => {
    // Pass 1: nodes
    for (const node of bundle.nodes) {
      let destId = node.id;
      if (strategy === 'reassign') {
        destId = ulid();
        idMap.set(node.id, destId);
        result.renamed++;
      }

      // C-A1: refuse to clobber a node belonging to a different namespace
      const elsewhere = findNodeAnywhere.get(destId) as { namespace: string } | undefined;
      if (elsewhere && elsewhere.namespace !== targetNs) {
        throw new Error(
          `Import aborted: node ${destId} already exists in namespace '${elsewhere.namespace}' ` +
          `(importing into '${targetNs}'). Use strategy 'reassign' to generate new IDs.`
        );
      }

      const existing = existsNode.get(destId, targetNs) as { version: number } | undefined;
      if (existing && strategy === 'skip') {
        result.skipped++;
        continue;
      }

      const propsStr = JSON.stringify(node.properties);
      const stmt = (strategy === 'overwrite' || strategy === 'reassign')
        ? replaceNode
        : (strategy === 'merge' && existing && existing.version >= node.version)
          ? null // keep existing
          : replaceNode;

      if (!stmt) {
        result.skipped++;
        continue;
      }

      stmt.run(
        destId, node.type, node.name, propsStr, node.summary,
        node.confidence, node.created_at, node.updated_at, node.version,
        node.archived ? 1 : 0, node.event_id, targetNs
      );
      result.importedNodes++;
    }

    // Pass 2: edges (remap source/target if reassigned)
    const findEdgeAnywhere = core.db.prepare('SELECT namespace FROM edges WHERE id = ?');
    for (const edge of bundle.edges) {
      const srcId = idMap.get(edge.source_id) ?? edge.source_id;
      const tgtId = idMap.get(edge.target_id) ?? edge.target_id;
      const edgeId = strategy === 'reassign' ? ulid() : edge.id;

      // C-A1 (edges): refuse cross-namespace edge ID collisions
      if (strategy !== 'reassign') {
        const elsewhere = findEdgeAnywhere.get(edgeId) as { namespace: string } | undefined;
        if (elsewhere && elsewhere.namespace !== targetNs) {
          throw new Error(
            `Import aborted: edge ${edgeId} already exists in namespace '${elsewhere.namespace}'. Use 'reassign'.`
          );
        }
      }

      insertEdge.run(
        edgeId, srcId, edge.predicate, tgtId,
        JSON.stringify(edge.properties), edge.confidence,
        edge.created_at, edge.updated_at, edge.version,
        edge.archived ? 1 : 0, edge.event_id, targetNs
      );
      result.importedEdges++;
    }

    // Pass 3: events (keep original for audit, don't re-chain)
    for (const event of bundle.events) {
      insertEvent.run(
        event.timestamp, event.type, event.source, event.session_id,
        JSON.stringify(event.content),
        event.state_ref ? JSON.stringify(event.state_ref) : null,
        event.checksum, targetNs
      );
      result.importedEvents++;
    }

    // Pass 4: history
    for (const h of bundle.history) {
      const nodeId = idMap.get(h.node_id) ?? h.node_id;
      insertHistory.run(
        nodeId, h.version, JSON.stringify(h.properties),
        h.changed_by, targetNs, h.timestamp
      );
    }
  });

  txn();
  return result;
}
