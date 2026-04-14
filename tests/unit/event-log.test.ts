import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-events.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run all main-db migrations in order — namespace migration requires nodes/edges tables
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of [
    '001_init_events.sql',
    '002_init_state_tree.sql',
    '003_init_node_history.sql',
    '005_add_namespaces.sql',
    '007_add_fts5.sql',
  ]) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }

  return db;
}

describe('EventLog', () => {
  let db: Database.Database;
  let eventLog: EventLog;

  beforeEach(() => {
    db = setupDb();
    eventLog = new EventLog(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should append an event and return it with id and timestamp', () => {
    const event = eventLog.append({
      type: 'observation',
      source: 'agent',
      content: { message: 'hello world' },
    });

    expect(event.id).toBe(1);
    expect(event.type).toBe('observation');
    expect(event.source).toBe('agent');
    expect(event.content).toEqual({ message: 'hello world' });
    expect(event.timestamp).toBeTruthy();
    expect(event.checksum).toBeTruthy();
  });

  it('should enforce immutability - UPDATE should fail', () => {
    eventLog.append({
      type: 'observation',
      source: 'user',
      content: { data: 'original' },
    });

    expect(() => {
      db.prepare("UPDATE events SET content = '{\"data\":\"modified\"}' WHERE id = 1").run();
    }).toThrow(/immutable/i);
  });

  it('should allow DELETE at DB level (application-level enforcement)', () => {
    // C3 fix: DELETE trigger removed to prevent rollback conflicts.
    // Immutability is enforced at the application level (EventLog has no delete method).
    eventLog.append({
      type: 'action',
      source: 'agent',
      content: { action: 'test' },
    });

    // Direct SQL delete now succeeds (but EventLog class doesn't expose this)
    expect(() => {
      db.prepare('DELETE FROM events WHERE id = 1').run();
    }).not.toThrow();
  });

  it('should maintain checksum chain integrity', () => {
    eventLog.append({ type: 'observation', source: 'user', content: { step: 1 } });
    eventLog.append({ type: 'action', source: 'agent', content: { step: 2 } });
    eventLog.append({ type: 'mutation', source: 'agent', content: { step: 3 } });

    const result = eventLog.verifyIntegrity();
    expect(result.valid).toBe(true);
  });

  it('should query events by type', () => {
    eventLog.append({ type: 'observation', source: 'user', content: { a: 1 } });
    eventLog.append({ type: 'action', source: 'agent', content: { b: 2 } });
    eventLog.append({ type: 'observation', source: 'user', content: { c: 3 } });

    const observations = eventLog.queryByType('observation');
    expect(observations).toHaveLength(2);
    expect(observations.every(e => e.type === 'observation')).toBe(true);
  });

  it('should query events by session_id', () => {
    eventLog.append({ type: 'observation', source: 'user', session_id: 'sess-1', content: { x: 1 } });
    eventLog.append({ type: 'action', source: 'agent', session_id: 'sess-1', content: { x: 2 } });
    eventLog.append({ type: 'observation', source: 'user', session_id: 'sess-2', content: { x: 3 } });

    const sess1 = eventLog.queryBySession('sess-1');
    expect(sess1).toHaveLength(2);
    expect(sess1[0].content).toEqual({ x: 1 });
  });

  it('should query recent events', () => {
    for (let i = 0; i < 10; i++) {
      eventLog.append({ type: 'observation', source: 'user', content: { i } });
    }

    const recent = eventLog.queryRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toEqual({ i: 9 });
  });

  it('should get event by id', () => {
    const created = eventLog.append({ type: 'system', source: 'system', content: { init: true } });
    const fetched = eventLog.getById(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.content).toEqual({ init: true });
  });

  it('should return null for non-existent event id', () => {
    const fetched = eventLog.getById(9999);
    expect(fetched).toBeNull();
  });

  it('should store state_ref as JSON array', () => {
    const event = eventLog.append({
      type: 'mutation',
      source: 'agent',
      content: { op: 'create' },
      state_ref: ['node-1', 'node-2'],
    });

    expect(event.state_ref).toEqual(['node-1', 'node-2']);
  });
});
