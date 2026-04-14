import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-ns.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const dir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const f of [
    '001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql',
    '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql',
  ]) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
  }
  return db;
}

describe('Namespace isolation post-fix', () => {
  let db: Database.Database;
  let treeA: StateTree;
  let treeB: StateTree;

  beforeEach(() => {
    db = setupDb();
    treeA = new StateTree(db, new EventLog(db, 'ns-a'), 'ns-a');
    treeB = new StateTree(db, new EventLog(db, 'ns-b'), 'ns-b');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('same triplet exists in different namespaces (C-A2)', () => {
    const a = treeA.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);
    const b = treeB.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);

    treeA.link([{ op: 'create', source_id: a.results[0].node_id, predicate: 'works_on', target_id: a.results[1].node_id }]);
    expect(() => treeB.link([{
      op: 'create',
      source_id: b.results[0].node_id,
      predicate: 'works_on',
      target_id: b.results[1].node_id,
    }])).not.toThrow();

    expect(treeA.getEdgesFrom(a.results[0].node_id).length).toBe(1);
    expect(treeB.getEdgesFrom(b.results[0].node_id).length).toBe(1);
  });

  it('link rejects cross-namespace source (C-A3)', () => {
    const a = treeA.mutate([{ op: 'create', type: 'person', name: 'Alice' }]);
    const b = treeB.mutate([{ op: 'create', type: 'project', name: 'Engram' }]);

    expect(() => treeB.link([{
      op: 'create',
      source_id: a.results[0].node_id,
      predicate: 'works_on',
      target_id: b.results[0].node_id,
    }])).toThrow(/source node .* not found in namespace/);
  });

  it('link rejects cross-namespace target (C-A3)', () => {
    const a = treeA.mutate([{ op: 'create', type: 'project', name: 'Engram' }]);
    const b = treeB.mutate([{ op: 'create', type: 'person', name: 'Bob' }]);

    expect(() => treeB.link([{
      op: 'create',
      source_id: b.results[0].node_id,
      predicate: 'works_on',
      target_id: a.results[0].node_id,
    }])).toThrow(/target node .* not found in namespace/);
  });

  it('getNode is namespace-scoped', () => {
    const a = treeA.mutate([{ op: 'create', type: 'person', name: 'Alice' }]);
    expect(treeA.getNode(a.results[0].node_id)).not.toBeNull();
    expect(treeB.getNode(a.results[0].node_id)).toBeNull();
  });

  it('getNodeByName is namespace-scoped', () => {
    treeA.mutate([{ op: 'create', type: 'person', name: 'SharedName' }]);
    treeB.mutate([{ op: 'create', type: 'person', name: 'SharedName' }]);

    const fromA = treeA.getNodeByName('SharedName');
    const fromB = treeB.getNodeByName('SharedName');
    expect(fromA).not.toBeNull();
    expect(fromB).not.toBeNull();
    expect(fromA!.id).not.toBe(fromB!.id);
  });

  it('event log chains are per-namespace', () => {
    treeA.mutate([{ op: 'create', type: 'person', name: 'Alice' }]);
    treeB.mutate([{ op: 'create', type: 'person', name: 'Bob' }]);
    treeA.mutate([{ op: 'create', type: 'person', name: 'Charlie' }]);

    const eventsA = db.prepare('SELECT * FROM events WHERE namespace = ?').all('ns-a') as any[];
    const eventsB = db.prepare('SELECT * FROM events WHERE namespace = ?').all('ns-b') as any[];
    expect(eventsA.length).toBe(2);
    expect(eventsB.length).toBe(1);
  });

  it('H-A4: node_history survives node delete (no cascade)', () => {
    const a = treeA.mutate([{ op: 'create', type: 'person', name: 'Alice', properties: { v: 1 } }]);
    treeA.mutate([{ op: 'update', node_id: a.results[0].node_id, set: { v: 2 } }]);
    treeA.mutate([{ op: 'delete', node_id: a.results[0].node_id }]);

    const history = db.prepare('SELECT * FROM node_history WHERE node_id = ?').all(a.results[0].node_id);
    // Should have 2 snapshots (v1 before update, v2 before delete) — both preserved
    expect(history.length).toBe(2);
  });
});
