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
import type { EventLog } from './event-log.js';

type Stmt = Database.Statement;

export class StateTree {
  // Node statements
  private insertNodeStmt: Stmt;
  private getNodeByIdStmt: Stmt;
  private getNodeByNameStmt: Stmt;
  private getNodesByTypeStmt: Stmt;
  private updateNodeStmt: Stmt;
  private deleteNodeStmt: Stmt;

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

  constructor(
    private db: Database.Database,
    private eventLog: EventLog,
  ) {
    // -- Nodes --
    this.insertNodeStmt = db.prepare(`
      INSERT INTO nodes (id, type, name, properties, summary, confidence, created_at, updated_at, event_id)
      VALUES (@id, @type, @name, @properties, @summary, @confidence,
              strftime('%Y-%m-%dT%H:%M:%f','now'), strftime('%Y-%m-%dT%H:%M:%f','now'), @event_id)
    `);

    this.getNodeByIdStmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
    this.getNodeByNameStmt = db.prepare('SELECT * FROM nodes WHERE name = ? AND archived = 0');
    this.getNodesByTypeStmt = db.prepare('SELECT * FROM nodes WHERE type = ? AND archived = 0 LIMIT ?');

    this.updateNodeStmt = db.prepare(`
      UPDATE nodes SET
        name = @name,
        properties = @properties,
        summary = @summary,
        confidence = @confidence,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'),
        version = version + 1,
        event_id = @event_id
      WHERE id = @id
    `);

    this.deleteNodeStmt = db.prepare('DELETE FROM nodes WHERE id = ?');

    // -- Edges --
    this.insertEdgeStmt = db.prepare(`
      INSERT INTO edges (id, source_id, predicate, target_id, properties, confidence, created_at, updated_at, event_id)
      VALUES (@id, @source_id, @predicate, @target_id, @properties, @confidence,
              strftime('%Y-%m-%dT%H:%M:%f','now'), strftime('%Y-%m-%dT%H:%M:%f','now'), @event_id)
    `);

    this.getEdgeByIdStmt = db.prepare('SELECT * FROM edges WHERE id = ?');
    this.getEdgeByTripletStmt = db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND predicate = ? AND target_id = ?'
    );
    this.getEdgesBySourceStmt = db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND archived = 0'
    );
    this.getEdgesByTargetStmt = db.prepare(
      'SELECT * FROM edges WHERE target_id = ? AND archived = 0'
    );

    this.updateEdgeStmt = db.prepare(`
      UPDATE edges SET
        properties = @properties,
        confidence = @confidence,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'),
        version = version + 1,
        event_id = @event_id
      WHERE id = @id
    `);

    this.deleteEdgeByIdStmt = db.prepare('DELETE FROM edges WHERE id = ?');
    this.deleteEdgeByTripletStmt = db.prepare(
      'DELETE FROM edges WHERE source_id = ? AND predicate = ? AND target_id = ?'
    );

    // -- History --
    this.insertHistoryStmt = db.prepare(`
      INSERT INTO node_history (node_id, version, properties, changed_by)
      VALUES (@node_id, @version, @properties, @changed_by)
    `);
  }

  // ─── Node Operations ─────────────────────────────────────────

  getNode(id: string): Node | null {
    const row = this.getNodeByIdStmt.get(id) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodeByName(name: string): Node | null {
    const row = this.getNodeByNameStmt.get(name) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodesByType(type: string, limit: number = 100): Node[] {
    const rows = this.getNodesByTypeStmt.all(type, limit) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  // ─── Edge Operations ─────────────────────────────────────────

  getEdge(id: string): Edge | null {
    const row = this.getEdgeByIdStmt.get(id) as EdgeRow | undefined;
    return row ? edgeFromRow(row) : null;
  }

  getEdgeByTriplet(sourceId: string, predicate: string, targetId: string): Edge | null {
    const row = this.getEdgeByTripletStmt.get(sourceId, predicate, targetId) as EdgeRow | undefined;
    return row ? edgeFromRow(row) : null;
  }

  getEdgesFrom(nodeId: string): Edge[] {
    const rows = this.getEdgesBySourceStmt.all(nodeId) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  getEdgesTo(nodeId: string): Edge[] {
    const rows = this.getEdgesByTargetStmt.all(nodeId) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  // ─── Mutation (Transactional) ─────────────────────────────────

  /**
   * Execute a batch of node mutations in a single transaction.
   * Automatically logs a mutation event.
   */
  mutate(operations: MutationOp[]): { results: MutationResult[]; event_id: number } {
    const results: MutationResult[] = [];
    const affectedNodeIds: string[] = [];

    const txn = this.db.transaction(() => {
      // Log the mutation event first to get an event_id
      const event = this.eventLog.append({
        type: 'mutation',
        source: 'agent',
        content: { operations },
        state_ref: [], // will be updated conceptually — IDs collected below
      });

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
              event_id: event.id,
            });
            results.push({ op: 'create', node_id: id, version: 1 });
            affectedNodeIds.push(id);
            break;
          }
          case 'update': {
            const existing = this.getNodeByIdStmt.get(op.node_id) as NodeRow | undefined;
            if (!existing) {
              throw new Error(`Node not found: ${op.node_id}`);
            }

            // Snapshot current state to history
            this.insertHistoryStmt.run({
              node_id: existing.id,
              version: existing.version,
              properties: existing.properties,
              changed_by: event.id,
            });

            // Merge properties
            const currentProps = JSON.parse(existing.properties) as Record<string, unknown>;
            if (op.set) {
              Object.assign(currentProps, op.set);
            }
            if (op.unset) {
              for (const key of op.unset) {
                delete currentProps[key];
              }
            }

            this.updateNodeStmt.run({
              id: op.node_id,
              name: op.name ?? existing.name,
              properties: JSON.stringify(currentProps),
              summary: op.summary ?? existing.summary,
              confidence: op.confidence ?? existing.confidence,
              event_id: event.id,
            });

            results.push({ op: 'update', node_id: op.node_id, version: existing.version + 1 });
            affectedNodeIds.push(op.node_id);
            break;
          }
          case 'delete': {
            const toDelete = this.getNodeByIdStmt.get(op.node_id) as NodeRow | undefined;
            if (!toDelete) {
              throw new Error(`Node not found: ${op.node_id}`);
            }
            // Snapshot before deletion
            this.insertHistoryStmt.run({
              node_id: toDelete.id,
              version: toDelete.version,
              properties: toDelete.properties,
              changed_by: event.id,
            });
            this.deleteNodeStmt.run(op.node_id);
            results.push({ op: 'delete', node_id: op.node_id, version: toDelete.version });
            affectedNodeIds.push(op.node_id);
            break;
          }
        }
      }

      return event.id;
    });

    const eventId = txn();
    return { results, event_id: eventId };
  }

  /**
   * Execute a batch of edge (link) operations in a single transaction.
   */
  link(operations: LinkOp[]): { results: LinkResult[]; event_id: number } {
    const results: LinkResult[] = [];

    const txn = this.db.transaction(() => {
      const event = this.eventLog.append({
        type: 'mutation',
        source: 'agent',
        content: { link_operations: operations },
      });

      for (const op of operations) {
        switch (op.op) {
          case 'create': {
            // UPSERT: if triplet exists, update instead
            const existing = this.getEdgeByTripletStmt.get(
              op.source_id, op.predicate, op.target_id
            ) as EdgeRow | undefined;

            if (existing) {
              const currentProps = JSON.parse(existing.properties) as Record<string, unknown>;
              const merged = { ...currentProps, ...(op.properties ?? {}) };
              this.updateEdgeStmt.run({
                id: existing.id,
                properties: JSON.stringify(merged),
                confidence: op.confidence ?? existing.confidence,
                event_id: event.id,
              });
              results.push({ op: 'update', edge_id: existing.id });
            } else {
              const id = ulid();
              this.insertEdgeStmt.run({
                id,
                source_id: op.source_id,
                predicate: op.predicate,
                target_id: op.target_id,
                properties: JSON.stringify(op.properties ?? {}),
                confidence: op.confidence ?? 1.0,
                event_id: event.id,
              });
              results.push({ op: 'create', edge_id: id });
            }
            break;
          }
          case 'update': {
            let edgeRow: EdgeRow | undefined;
            if (op.edge_id) {
              edgeRow = this.getEdgeByIdStmt.get(op.edge_id) as EdgeRow | undefined;
            } else if (op.source_id && op.predicate && op.target_id) {
              edgeRow = this.getEdgeByTripletStmt.get(
                op.source_id, op.predicate, op.target_id
              ) as EdgeRow | undefined;
            }

            if (!edgeRow) {
              throw new Error('Edge not found for update');
            }

            const currentProps = JSON.parse(edgeRow.properties) as Record<string, unknown>;
            const merged = { ...currentProps, ...(op.set ?? {}) };

            this.updateEdgeStmt.run({
              id: edgeRow.id,
              properties: JSON.stringify(merged),
              confidence: op.confidence ?? edgeRow.confidence,
              event_id: event.id,
            });
            results.push({ op: 'update', edge_id: edgeRow.id });
            break;
          }
          case 'delete': {
            if (op.edge_id) {
              this.deleteEdgeByIdStmt.run(op.edge_id);
              results.push({ op: 'delete', edge_id: op.edge_id });
            } else if (op.source_id && op.predicate && op.target_id) {
              this.deleteEdgeByTripletStmt.run(op.source_id, op.predicate, op.target_id);
              results.push({ op: 'delete', edge_id: `${op.source_id}:${op.predicate}:${op.target_id}` });
            }
            break;
          }
        }
      }

      return event.id;
    });

    const eventId = txn();
    return { results, event_id: eventId };
  }
}
