import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Event, EventType, EventSource, EventRow } from '../types/index.js';
import { eventFromRow } from '../types/index.js';

type Stmt = Database.Statement;

export class EventLog {
  private insertStmt: Stmt;
  private getByIdStmt: Stmt;
  private getLastStmt: Stmt;
  private queryByTypeStmt: Stmt;
  private queryBySessionStmt: Stmt;
  private queryRecentStmt: Stmt;
  private appendTxn: (params: {
    type: EventType;
    source: EventSource;
    session_id?: string;
    content: Record<string, unknown>;
    state_ref?: string[];
  }) => Event;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO events (type, source, session_id, content, state_ref, checksum)
      VALUES (@type, @source, @session_id, @content, @state_ref, @checksum)
    `);

    this.getByIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    this.getLastStmt = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1');
    this.queryByTypeStmt = db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?');
    this.queryBySessionStmt = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC');
    this.queryRecentStmt = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');

    // C2 fix: Atomic read-last-checksum + insert prevents checksum chain race conditions
    this.appendTxn = db.transaction((params: {
      type: EventType;
      source: EventSource;
      session_id?: string;
      content: Record<string, unknown>;
      state_ref?: string[];
    }): Event => {
      const contentStr = JSON.stringify(params.content);
      const stateRefStr = params.state_ref ? JSON.stringify(params.state_ref) : null;

      const lastEvent = this.getLastStmt.get() as EventRow | undefined;
      const prevChecksum = lastEvent?.checksum ?? '';
      const checksum = createHash('sha256')
        .update(prevChecksum + contentStr)
        .digest('hex');

      const result = this.insertStmt.run({
        type: params.type,
        source: params.source,
        session_id: params.session_id ?? null,
        content: contentStr,
        state_ref: stateRefStr,
        checksum,
      });

      const row = this.getByIdStmt.get(result.lastInsertRowid) as EventRow;
      return eventFromRow(row);
    });
  }

  append(params: {
    type: EventType;
    source: EventSource;
    session_id?: string;
    content: Record<string, unknown>;
    state_ref?: string[];
  }): Event {
    return this.appendTxn(params);
  }

  getById(id: number): Event | null {
    const row = this.getByIdStmt.get(id) as EventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  queryByType(type: EventType, limit: number = 50): Event[] {
    const rows = this.queryByTypeStmt.all(type, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  queryBySession(sessionId: string): Event[] {
    const rows = this.queryBySessionStmt.all(sessionId) as EventRow[];
    return rows.map(eventFromRow);
  }

  queryRecent(limit: number = 50): Event[] {
    const rows = this.queryRecentStmt.all(limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  verifyIntegrity(): { valid: boolean; brokenAt?: number } {
    const allEvents = this.db
      .prepare('SELECT * FROM events ORDER BY id ASC')
      .all() as EventRow[];

    let prevChecksum = '';

    for (const row of allEvents) {
      const expected = createHash('sha256')
        .update(prevChecksum + row.content)
        .digest('hex');

      if (row.checksum !== expected) {
        return { valid: false, brokenAt: row.id };
      }

      prevChecksum = row.checksum!;
    }

    return { valid: true };
  }
}
