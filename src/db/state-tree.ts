import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  Node,
  Edge,
  NodeRow,
  EdgeRow,
  MutationOp,
  MutationResult,
  LinkOp,
  LinkResult,
} from '../types/index.js';
import { nodeFromRow, edgeFromRow } from '../types/index.js';
import { safeJsonParse } from '../utils.js';
import { metrics, startTimer, safeNamespaceLabel } from '../metrics.js';
import type { EventLog } from './event-log.js';

type Stmt = Database.Statement;

/**
 * Callback invoked after a successful mutation with affected node IDs.
 * May be async — returned promises are awaited in the background (fire-and-forget).
 * Errors are logged but do not propagate.
 */
export type MutationCallback = (nodeIds: string[]) => void | Promise<void>;

export class StateTree {
  private namespace: string;

  // Node statements
  private insertNodeStmt: Stmt;
  private getNodeByIdStmt: Stmt;
  private getNodeByNameStmt: Stmt;
  private getNodesByTypeStmt: Stmt;
  private updateNodeStmt: Stmt;
  private deleteNodeStmt: Stmt;
  private searchNodesByNameStmt: Stmt;
  private searchAllNodesStmt: Stmt;

  // Edge statements
  private insertEdgeStmt: Stmt;
  private getEdgeByIdStmt: Stmt;
  private getEdgeByTripletStmt: Stmt;
  private getEdgesBySourceStmt: Stmt;
  private getEdgesByTargetStmt: Stmt;
  private updateEdgeStmt: Stmt;
  private deleteEdgeByIdStmt: Stmt;
  private deleteEdgeByTripletStmt: Stmt;

  // History statement
  private insertHistoryStmt: Stmt;

  // Post-mutation callbacks
  private onMutateCallbacks: MutationCallback[] = [];
  private pendingCallbacks: Set<Promise<void>> = new Set();

  constructor(
    private db: Database.Database,
    private eventLog: EventLog,
    namespace: string = 'default',
  ) {
    this.namespace = namespace;

    // -- Nodes --
    this.insertNodeStmt = db.prepare(`
      INSERT INTO nodes (id, type, name, properties, summary, confidence, created_at, updated_at, event_id, namespace)
      VALUES (@id, @type, @name, @properties, @summary, @confidence,
              strftime('%Y-%m-%dT%H:%M:%f','now'), strftime('%Y-%m-%dT%H:%M:%f','now'), @event_id, @namespace)
    `);

    this.getNodeByIdStmt = db.prepare('SELECT * FROM nodes WHERE id = ? AND namespace = ?');
    this.getNodeByNameStmt = db.prepare('SELECT * FROM nodes WHERE name = ? AND namespace = ? AND archived = 0 LIMIT 1');
    this.getNodesByTypeStmt = db.prepare('SELECT * FROM nodes WHERE type = ? AND namespace = ? AND archived = 0 LIMIT ?');
    this.searchNodesByNameStmt = db.prepare(
      'SELECT * FROM nodes WHERE name = ? AND type = ? AND namespace = ? AND archived = 0 LIMIT 1'
    );
    this.searchAllNodesStmt = db.prepare(
      'SELECT * FROM nodes WHERE namespace = ? AND archived = 0 LIMIT ?'
    );

    this.updateNodeStmt = db.prepare(`
      UPDATE nodes SET
        name = @name,
        properties = @properties,
        summary = @summary,
        confidence = @confidence,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'),
        version = version + 1,
        event_id = @event_id
      WHERE id = @id AND namespace = @namespace
    `);

    this.deleteNodeStmt = db.prepare('DELETE FROM nodes WHERE id = ? AND namespace = ?');

    // -- Edges --
    this.insertEdgeStmt = db.prepare(`
      INSERT INTO edges (id, source_id, predicate, target_id, properties, confidence, created_at, updated_at, event_id, namespace)
      VALUES (@id, @source_id, @predicate, @target_id, @properties, @confidence,
              strftime('%Y-%m-%dT%H:%M:%f','now'), strftime('%Y-%m-%dT%H:%M:%f','now'), @event_id, @namespace)
    `);

    this.getEdgeByIdStmt = db.prepare('SELECT * FROM edges WHERE id = ? AND namespace = ?');
    this.getEdgeByTripletStmt = db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND predicate = ? AND target_id = ? AND namespace = ?'
    );
    this.getEdgesBySourceStmt = db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND namespace = ? AND archived = 0'
    );
    this.getEdgesByTargetStmt = db.prepare(
      'SELECT * FROM edges WHERE target_id = ? AND namespace = ? AND archived = 0'
    );

    this.updateEdgeStmt = db.prepare(`
      UPDATE edges SET
        properties = @properties,
        confidence = @confidence,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'),
        version = version + 1,
        event_id = @event_id
      WHERE id = @id AND namespace = @namespace
    `);

    this.deleteEdgeByIdStmt = db.prepare('DELETE FROM edges WHERE id = ? AND namespace = ?');
    this.deleteEdgeByTripletStmt = db.prepare(
      'DELETE FROM edges WHERE source_id = ? AND predicate = ? AND target_id = ? AND namespace = ?'
    );

    // -- History --
    this.insertHistoryStmt = db.prepare(`
      INSERT INTO node_history (node_id, version, properties, changed_by, namespace)
      VALUES (@node_id, @version, @properties, @changed_by, @namespace)
    `);
  }

  /** Returns the namespace this instance operates on */
  get ns(): string {
    return this.namespace;
  }

  /** Register a callback to be invoked after successful mutations */
  onMutate(callback: MutationCallback): void {
    this.onMutateCallbacks.push(callback);
  }

  // ─── Node Operations ─────────────────────────────────────────

  getNode(id: string): Node | null {
    const row = this.getNodeByIdStmt.get(id, this.namespace) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodeByName(name: string): Node | null {
    const row = this.getNodeByNameStmt.get(name, this.namespace) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodeByNameAndType(name: string, type: string): Node | null {
    const row = this.searchNodesByNameStmt.get(name, type, this.namespace) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodesByType(type: string, limit: number = 100): Node[] {
    const rows = this.getNodesByTypeStmt.all(type, this.namespace, limit) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  searchAllNodes(limit: number = 100): Node[] {
    const rows = this.searchAllNodesStmt.all(this.namespace, limit) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  /**
   * FTS5-backed full-text search across node name, type, summary, and properties.
   * Orders by BM25 relevance. Scoped to this namespace.
   *
   * Query syntax supports FTS5 operators: `AND`, `OR`, `NOT`, phrase `"..."`, prefix `foo*`.
   * Plain words are treated as AND by default.
   */
  searchFts(query: string, limit: number = 50): Node[] {
    // FTS5 tokenizes and matches across all indexed columns
    const rows = this.db.prepare(`
      SELECT n.* FROM nodes_fts f
      INNER JOIN nodes n ON n.id = f.id
      WHERE f.nodes_fts MATCH ? AND f.namespace = ?
        AND n.archived = 0
      ORDER BY rank
      LIMIT ?
    `).all(query, this.namespace, limit) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  // ─── Edge Operations ─────────────────────────────────────────

  getEdge(id: string): Edge | null {
    const row = this.getEdgeByIdStmt.get(id, this.namespace) as EdgeRow | undefined;
    return row ? edgeFromRow(row) : null;
  }

  getEdgeByTriplet(sourceId: string, predicate: string, targetId: string): Edge | null {
    const row = this.getEdgeByTripletStmt.get(sourceId, predicate, targetId, this.namespace) as EdgeRow | undefined;
    return row ? edgeFromRow(row) : null;
  }

  getEdgesFrom(nodeId: string): Edge[] {
    const rows = this.getEdgesBySourceStmt.all(nodeId, this.namespace) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  getEdgesTo(nodeId: string): Edge[] {
    const rows = this.getEdgesByTargetStmt.all(nodeId, this.namespace) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  // ─── Mutation ────────────────────────────────────────────────

  mutate(operations: MutationOp[]): { results: MutationResult[]; event_id: number } {
    const stopTimer = startTimer();
    const results: MutationResult[] = [];
    const affectedNodeIds: string[] = [];
    const historyRowIds: Array<number | bigint> = []; // M8: track exact history rows to attach event_id to

    const mutationTxn = this.db.transaction(() => {
      for (const op of operations) {
        switch (op.op) {
          case 'create': {
            const id = ulid();
            this.insertNodeStmt.run({
              id,
              type: op.type,
              name: op.name,
              properties: JSON.stringify(op.properties ?? {}),
              summary: op.summary ?? null,
              confidence: op.confidence ?? 1.0,
              event_id: null,
              namespace: this.namespace,
            });
            results.push({ op: 'create', node_id: id, version: 1 });
            affectedNodeIds.push(id);
            break;
          }
          case 'update': {
            const existing = this.getNodeByIdStmt.get(op.node_id, this.namespace) as NodeRow | undefined;
            if (!existing) {
              throw new Error(`Node not found: ${op.node_id}`);
            }

            const histResult = this.insertHistoryStmt.run({
              node_id: existing.id,
              version: existing.version,
              properties: existing.properties,
              changed_by: null,
              namespace: this.namespace,
            });
            historyRowIds.push(histResult.lastInsertRowid);

            const currentProps = safeJsonParse(existing.properties);
            if (op.set) Object.assign(currentProps, op.set);
            if (op.unset) for (const key of op.unset) delete currentProps[key];

            this.updateNodeStmt.run({
              id: op.node_id,
              name: op.name ?? existing.name,
              properties: JSON.stringify(currentProps),
              summary: op.summary ?? existing.summary,
              confidence: op.confidence ?? existing.confidence,
              event_id: null,
              namespace: this.namespace,
            });

            results.push({ op: 'update', node_id: op.node_id, version: existing.version + 1 });
            affectedNodeIds.push(op.node_id);
            break;
          }
          case 'delete': {
            const toDelete = this.getNodeByIdStmt.get(op.node_id, this.namespace) as NodeRow | undefined;
            if (!toDelete) {
              throw new Error(`Node not found: ${op.node_id}`);
            }
            const histResult = this.insertHistoryStmt.run({
              node_id: toDelete.id,
              version: toDelete.version,
              properties: toDelete.properties,
              changed_by: null,
              namespace: this.namespace,
            });
            historyRowIds.push(histResult.lastInsertRowid);
            this.deleteNodeStmt.run(op.node_id, this.namespace);
            results.push({ op: 'delete', node_id: op.node_id, version: toDelete.version });
            affectedNodeIds.push(op.node_id);
            break;
          }
        }
      }
    });

    mutationTxn();

    const event = this.eventLog.append({
      type: 'mutation',
      source: 'agent',
      content: { operations },
      state_ref: affectedNodeIds,
    });

    const updateEventRef = this.db.prepare(
      'UPDATE nodes SET event_id = ? WHERE id = ? AND namespace = ?'
    );
    // M8: update only THIS mutation's history rows, by exact rowid
    const updateHistoryById = this.db.prepare(
      'UPDATE node_history SET changed_by = ? WHERE id = ?'
    );
    for (const nodeId of affectedNodeIds) {
      const exists = this.getNodeByIdStmt.get(nodeId, this.namespace) as NodeRow | undefined;
      if (exists) {
        updateEventRef.run(event.id, nodeId, this.namespace);
      }
    }
    for (const rowid of historyRowIds) {
      updateHistoryById.run(event.id, rowid);
    }

    this.fireCallbacks(affectedNodeIds);

    metrics.mutations.inc({ namespace: safeNamespaceLabel(this.namespace), kind: 'node' }, operations.length);
    metrics.mutationDuration.observe({ namespace: safeNamespaceLabel(this.namespace), kind: 'node' }, stopTimer());

    return { results, event_id: event.id };
  }

  link(operations: LinkOp[]): { results: LinkResult[]; event_id: number } {
    const stopTimer = startTimer();
    const results: LinkResult[] = [];
    const affectedEdgeIds: string[] = [];

    const linkTxn = this.db.transaction(() => {
      for (const op of operations) {
        switch (op.op) {
          case 'create': {
            // C-A3: verify source/target nodes belong to this namespace
            const src = this.getNodeByIdStmt.get(op.source_id, this.namespace) as NodeRow | undefined;
            if (!src) {
              throw new Error(
                `Cannot create edge: source node ${op.source_id} not found in namespace '${this.namespace}'`
              );
            }
            const tgt = this.getNodeByIdStmt.get(op.target_id, this.namespace) as NodeRow | undefined;
            if (!tgt) {
              throw new Error(
                `Cannot create edge: target node ${op.target_id} not found in namespace '${this.namespace}'`
              );
            }

            const existing = this.getEdgeByTripletStmt.get(
              op.source_id, op.predicate, op.target_id, this.namespace
            ) as EdgeRow | undefined;

            if (existing) {
              const currentProps = safeJsonParse(existing.properties);
              const merged = { ...currentProps, ...(op.properties ?? {}) };
              this.updateEdgeStmt.run({
                id: existing.id,
                properties: JSON.stringify(merged),
                confidence: op.confidence ?? existing.confidence,
                event_id: null,
                namespace: this.namespace,
              });
              results.push({ op: 'update', edge_id: existing.id });
              affectedEdgeIds.push(existing.id);
            } else {
              const id = ulid();
              this.insertEdgeStmt.run({
                id,
                source_id: op.source_id,
                predicate: op.predicate,
                target_id: op.target_id,
                properties: JSON.stringify(op.properties ?? {}),
                confidence: op.confidence ?? 1.0,
                event_id: null,
                namespace: this.namespace,
              });
              results.push({ op: 'create', edge_id: id });
              affectedEdgeIds.push(id);
            }
            break;
          }
          case 'update': {
            let edgeRow: EdgeRow | undefined;
            if (op.edge_id) {
              edgeRow = this.getEdgeByIdStmt.get(op.edge_id, this.namespace) as EdgeRow | undefined;
            } else if (op.source_id && op.predicate && op.target_id) {
              edgeRow = this.getEdgeByTripletStmt.get(
                op.source_id, op.predicate, op.target_id, this.namespace
              ) as EdgeRow | undefined;
            }

            if (!edgeRow) {
              throw new Error('Edge not found for update');
            }

            const currentProps = safeJsonParse(edgeRow.properties);
            const merged = { ...currentProps, ...(op.set ?? {}) };

            this.updateEdgeStmt.run({
              id: edgeRow.id,
              properties: JSON.stringify(merged),
              confidence: op.confidence ?? edgeRow.confidence,
              event_id: null,
              namespace: this.namespace,
            });
            results.push({ op: 'update', edge_id: edgeRow.id });
            affectedEdgeIds.push(edgeRow.id);
            break;
          }
          case 'delete': {
            if (op.edge_id) {
              const exists = this.getEdgeByIdStmt.get(op.edge_id, this.namespace) as EdgeRow | undefined;
              if (!exists) {
                results.push({ op: 'delete', edge_id: op.edge_id });
                break;
              }
              this.deleteEdgeByIdStmt.run(op.edge_id, this.namespace);
              results.push({ op: 'delete', edge_id: op.edge_id });
            } else if (op.source_id && op.predicate && op.target_id) {
              this.deleteEdgeByTripletStmt.run(op.source_id, op.predicate, op.target_id, this.namespace);
              results.push({ op: 'delete', edge_id: `${op.source_id}:${op.predicate}:${op.target_id}` });
            } else {
              throw new Error('Delete requires edge_id or complete triplet');
            }
            break;
          }
        }
      }
    });

    linkTxn();

    const event = this.eventLog.append({
      type: 'mutation',
      source: 'agent',
      content: { link_operations: operations },
      state_ref: affectedEdgeIds,
    });

    const updateEdgeRef = this.db.prepare(
      'UPDATE edges SET event_id = ? WHERE id = ? AND namespace = ?'
    );
    const affectedNodeIds = new Set<string>();
    for (const edgeId of affectedEdgeIds) {
      const exists = this.getEdgeByIdStmt.get(edgeId, this.namespace) as EdgeRow | undefined;
      if (exists) {
        updateEdgeRef.run(event.id, edgeId, this.namespace);
        affectedNodeIds.add(exists.source_id);
        affectedNodeIds.add(exists.target_id);
      }
    }

    if (affectedNodeIds.size > 0) {
      this.fireCallbacks([...affectedNodeIds]);
    }

    metrics.mutations.inc({ namespace: safeNamespaceLabel(this.namespace), kind: 'edge' }, operations.length);
    metrics.mutationDuration.observe({ namespace: safeNamespaceLabel(this.namespace), kind: 'edge' }, stopTimer());

    return { results, event_id: event.id };
  }

  private fireCallbacks(nodeIds: string[]): void {
    for (const cb of this.onMutateCallbacks) {
      try {
        const maybePromise = cb(nodeIds);
        if (maybePromise instanceof Promise) {
          const tracked = maybePromise
            .catch(err => { console.error('[StateTree] onMutate callback error:', err); })
            .finally(() => { this.pendingCallbacks.delete(tracked); });
          this.pendingCallbacks.add(tracked);
        }
      } catch (err) {
        console.error('[StateTree] onMutate callback error:', err);
      }
    }
  }

  async drainCallbacks(): Promise<void> {
    while (this.pendingCallbacks.size > 0) {
      await Promise.allSettled([...this.pendingCallbacks]);
    }
  }

  /**
   * Merge sourceId into targetId:
   * - Re-points all edges where source_id=sourceId to source_id=targetId
   * - Re-points all edges where target_id=sourceId to target_id=targetId
   * - Merges source.properties into target.properties (target wins on conflict)
   * - Appends source.summary to target.summary if target has no summary
   * - Archives source node (keeps audit trail)
   * - Deduplicates edges that become identical after re-point
   *
   * Returns affected edge count and the merged target state.
   */
  mergeNodes(sourceId: string, targetId: string): {
    target_id: string;
    merged_edges: number;
    dedup_edges: number;
  } {
    if (sourceId === targetId) {
      throw new Error('Cannot merge a node into itself');
    }

    const source = this.getNodeByIdStmt.get(sourceId, this.namespace) as NodeRow | undefined;
    const target = this.getNodeByIdStmt.get(targetId, this.namespace) as NodeRow | undefined;
    if (!source) throw new Error(`Source node not found: ${sourceId}`);
    if (!target) throw new Error(`Target node not found: ${targetId}`);

    let mergedEdges = 0;
    let dedupEdges = 0;
    let historyRowId: number | bigint = 0;

    const txn = this.db.transaction(() => {
      // 1. Snapshot target before merge (M8: track rowid for exact attach later)
      const histResult = this.insertHistoryStmt.run({
        node_id: target.id,
        version: target.version,
        properties: target.properties,
        changed_by: null,
        namespace: this.namespace,
      });
      historyRowId = histResult.lastInsertRowid;

      // 2. Merge properties (target wins on key conflict — target is the canonical entity)
      const sourceProps = safeJsonParse(source.properties);
      const targetProps = safeJsonParse(target.properties);
      const merged = { ...sourceProps, ...targetProps };

      const mergedSummary = target.summary ?? source.summary;

      this.updateNodeStmt.run({
        id: target.id,
        name: target.name,
        properties: JSON.stringify(merged),
        summary: mergedSummary,
        confidence: target.confidence,
        event_id: null,
        namespace: this.namespace,
      });

      // 3. Re-point edges from source to target
      // Outgoing edges: source --predicate--> X becomes target --predicate--> X
      //   If target --predicate--> X already exists: delete the source edge (dedup)
      const outEdges = this.getEdgesBySourceStmt.all(source.id, this.namespace) as EdgeRow[];
      for (const e of outEdges) {
        const existing = this.getEdgeByTripletStmt.get(
          target.id, e.predicate, e.target_id, this.namespace
        ) as EdgeRow | undefined;
        if (existing && existing.id !== e.id) {
          this.deleteEdgeByIdStmt.run(e.id, this.namespace);
          dedupEdges++;
        } else {
          this.db.prepare(
            'UPDATE edges SET source_id = ? WHERE id = ? AND namespace = ?'
          ).run(target.id, e.id, this.namespace);
          mergedEdges++;
        }
      }

      // Incoming edges: X --predicate--> source becomes X --predicate--> target
      const inEdges = this.getEdgesByTargetStmt.all(source.id, this.namespace) as EdgeRow[];
      for (const e of inEdges) {
        const existing = this.getEdgeByTripletStmt.get(
          e.source_id, e.predicate, target.id, this.namespace
        ) as EdgeRow | undefined;
        if (existing && existing.id !== e.id) {
          this.deleteEdgeByIdStmt.run(e.id, this.namespace);
          dedupEdges++;
        } else {
          this.db.prepare(
            'UPDATE edges SET target_id = ? WHERE id = ? AND namespace = ?'
          ).run(target.id, e.id, this.namespace);
          mergedEdges++;
        }
      }

      // 4. Archive source (keeps history, excludes from active queries)
      this.db.prepare(
        'UPDATE nodes SET archived = 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%f\',\'now\') WHERE id = ? AND namespace = ?'
      ).run(source.id, this.namespace);
    });

    txn();

    // Log merge event
    const event = this.eventLog.append({
      type: 'mutation',
      source: 'agent',
      content: {
        operation: 'merge_nodes',
        source_id: sourceId,
        target_id: targetId,
        merged_edges: mergedEdges,
        dedup_edges: dedupEdges,
      },
      state_ref: [sourceId, targetId],
    });

    // Reference the event on target and the specific history row we inserted
    this.db.prepare('UPDATE nodes SET event_id = ? WHERE id = ? AND namespace = ?')
      .run(event.id, target.id, this.namespace);
    this.db.prepare('UPDATE node_history SET changed_by = ? WHERE id = ?')
      .run(event.id, historyRowId);

    // Fire callbacks for both nodes (cache invalidation, re-embed)
    this.fireCallbacks([sourceId, targetId]);

    return {
      target_id: targetId,
      merged_edges: mergedEdges,
      dedup_edges: dedupEdges,
    };
  }
}
