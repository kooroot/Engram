import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-state.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const migrationsDir = path.join(
    import.meta.dirname, '..', '..', 'src', 'db', 'migrations'
  );
  for (const file of ['001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql', '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql']) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }

  return db;
}

describe('StateTree - Node Operations', () => {
  let db: Database.Database;
  let eventLog: EventLog;
  let stateTree: StateTree;

  beforeEach(() => {
    db = setupDb();
    eventLog = new EventLog(db);
    stateTree = new StateTree(db, eventLog);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should create a node and return it', () => {
    const { results, event_id } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice', properties: { role: 'engineer' } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].op).toBe('create');
    expect(results[0].version).toBe(1);
    expect(event_id).toBeGreaterThan(0);

    const node = stateTree.getNode(results[0].node_id);
    expect(node).not.toBeNull();
    expect(node!.name).toBe('Alice');
    expect(node!.type).toBe('person');
    expect(node!.properties).toEqual({ role: 'engineer' });
    expect(node!.confidence).toBe(1.0);
    expect(node!.version).toBe(1);
    expect(node!.archived).toBe(false);
  });

  it('should update a node with property merge', () => {
    const { results: created } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Bob', properties: { role: 'designer', level: 'senior' } },
    ]);
    const nodeId = created[0].node_id;

    const { results: updated } = stateTree.mutate([
      { op: 'update', node_id: nodeId, set: { level: 'lead', team: 'platform' }, unset: ['role'] },
    ]);

    expect(updated[0].version).toBe(2);

    const node = stateTree.getNode(nodeId);
    expect(node!.properties).toEqual({ level: 'lead', team: 'platform' });
  });

  it('should snapshot to node_history on update', () => {
    const { results: created } = stateTree.mutate([
      { op: 'create', type: 'concept', name: 'GraphDB', properties: { status: 'exploring' } },
    ]);
    const nodeId = created[0].node_id;

    stateTree.mutate([
      { op: 'update', node_id: nodeId, set: { status: 'adopted' } },
    ]);

    const history = db
      .prepare('SELECT * FROM node_history WHERE node_id = ?')
      .all(nodeId) as Array<{ properties: string; version: number }>;
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0].properties)).toEqual({ status: 'exploring' });
    expect(history[0].version).toBe(1);
  });

  it('should delete a node and cascade edges', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Charlie' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);
    const [charlie, engram] = results;

    stateTree.link([
      { op: 'create', source_id: charlie.node_id, predicate: 'works_on', target_id: engram.node_id },
    ]);

    const edgesBefore = stateTree.getEdgesFrom(charlie.node_id);
    expect(edgesBefore).toHaveLength(1);

    stateTree.mutate([{ op: 'delete', node_id: charlie.node_id }]);

    const node = stateTree.getNode(charlie.node_id);
    expect(node).toBeNull();

    const edgesAfter = stateTree.getEdgesFrom(charlie.node_id);
    expect(edgesAfter).toHaveLength(0);
  });

  it('should throw on update of non-existent node', () => {
    expect(() => {
      stateTree.mutate([{ op: 'update', node_id: 'non-existent', set: { x: 1 } }]);
    }).toThrow(/not found/i);
  });

  it('should get node by name', () => {
    stateTree.mutate([{ op: 'create', type: 'person', name: 'Diana' }]);

    const node = stateTree.getNodeByName('Diana');
    expect(node).not.toBeNull();
    expect(node!.type).toBe('person');
  });

  it('should get nodes by type', () => {
    stateTree.mutate([
      { op: 'create', type: 'person', name: 'Eve' },
      { op: 'create', type: 'person', name: 'Frank' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);

    const people = stateTree.getNodesByType('person');
    expect(people).toHaveLength(2);
  });

  it('should handle multiple operations in a single transaction', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Grace' },
      { op: 'create', type: 'person', name: 'Hank' },
      { op: 'create', type: 'concept', name: 'Memory', properties: { domain: 'AI' } },
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.op === 'create')).toBe(true);
  });
});

describe('StateTree - Edge Operations', () => {
  let db: Database.Database;
  let eventLog: EventLog;
  let stateTree: StateTree;

  beforeEach(() => {
    db = setupDb();
    eventLog = new EventLog(db);
    stateTree = new StateTree(db, eventLog);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should create an edge between two nodes', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);

    const { results: linkResults } = stateTree.link([
      { op: 'create', source_id: results[0].node_id, predicate: 'works_on', target_id: results[1].node_id },
    ]);

    expect(linkResults).toHaveLength(1);
    expect(linkResults[0].op).toBe('create');

    const edges = stateTree.getEdgesFrom(results[0].node_id);
    expect(edges).toHaveLength(1);
    expect(edges[0].predicate).toBe('works_on');
  });

  it('should upsert on duplicate triplet', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Bob' },
      { op: 'create', type: 'concept', name: 'TypeScript' },
    ]);

    stateTree.link([
      {
        op: 'create',
        source_id: results[0].node_id,
        predicate: 'knows',
        target_id: results[1].node_id,
        properties: { level: 'beginner' },
      },
    ]);

    const { results: upsertResults } = stateTree.link([
      {
        op: 'create',
        source_id: results[0].node_id,
        predicate: 'knows',
        target_id: results[1].node_id,
        properties: { level: 'expert' },
      },
    ]);

    expect(upsertResults[0].op).toBe('update');

    const edge = stateTree.getEdgeByTriplet(results[0].node_id, 'knows', results[1].node_id);
    expect(edge!.properties).toEqual({ level: 'expert' });
  });

  it('should get edges from and to a node', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
      { op: 'create', type: 'person', name: 'Bob' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);

    const [alice, bob, engram] = results;

    stateTree.link([
      { op: 'create', source_id: alice.node_id, predicate: 'works_on', target_id: engram.node_id },
      { op: 'create', source_id: bob.node_id, predicate: 'works_on', target_id: engram.node_id },
      { op: 'create', source_id: alice.node_id, predicate: 'knows', target_id: bob.node_id },
    ]);

    const aliceOutgoing = stateTree.getEdgesFrom(alice.node_id);
    expect(aliceOutgoing).toHaveLength(2);

    const engramIncoming = stateTree.getEdgesTo(engram.node_id);
    expect(engramIncoming).toHaveLength(2);
  });

  it('should delete an edge by triplet', () => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
      { op: 'create', type: 'person', name: 'Bob' },
    ]);

    stateTree.link([
      { op: 'create', source_id: results[0].node_id, predicate: 'knows', target_id: results[1].node_id },
    ]);

    stateTree.link([
      { op: 'delete', source_id: results[0].node_id, predicate: 'knows', target_id: results[1].node_id },
    ]);

    const edge = stateTree.getEdgeByTriplet(results[0].node_id, 'knows', results[1].node_id);
    expect(edge).toBeNull();
  });

  it('should log mutation events for edge operations', () => {
    stateTree.mutate([{ op: 'create', type: 'person', name: 'Alice' }]);
    stateTree.mutate([{ op: 'create', type: 'person', name: 'Bob' }]);

    const mutations = eventLog.queryByType('mutation');
    expect(mutations.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Phase 6a: auto-dedup on mutate_state create ────────────────

  it('auto-merges duplicate creates with the same exact name', () => {
    const first = stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram', properties: { a: 1 } },
    ]);
    const firstId = first.results[0].node_id;

    const second = stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram', properties: { b: 2 } },
    ]);

    expect(second.results).toHaveLength(1);
    expect(second.results[0].auto_merged).toBe(true);
    expect(second.results[0].matched_by).toBe('exact');
    expect(second.results[0].node_id).toBe(firstId);
    expect(second.results[0].op).toBe('update');
    expect(second.results[0].version).toBe(2);

    const node = stateTree.getNode(firstId);
    expect(node).not.toBeNull();
    expect(node!.properties).toEqual({ a: 1, b: 2 });
  });

  it('auto-merges via substring match and keeps canonical existing name', () => {
    const first = stateTree.mutate([
      { op: 'create', type: 'project', name: 'engram', summary: 'original' },
    ]);
    const firstId = first.results[0].node_id;

    const second = stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram Twin Mode', properties: { mode: 'twin' } },
    ]);

    expect(second.results[0].auto_merged).toBe(true);
    expect(second.results[0].matched_by).toBe('substring');
    expect(second.results[0].node_id).toBe(firstId);
    expect(second.results[0].requested_name).toBe('Engram Twin Mode');

    const node = stateTree.getNode(firstId);
    // Canonical existing name is preserved
    expect(node!.name).toBe('engram');
    expect(node!.properties).toEqual({ mode: 'twin' });
  });

  it('allows same name across different types (type gate)', () => {
    const a = stateTree.mutate([
      { op: 'create', type: 'project', name: 'bun' },
    ]);
    const b = stateTree.mutate([
      { op: 'create', type: 'preference', name: 'bun' },
    ]);

    expect(a.results[0].auto_merged).toBeUndefined();
    expect(b.results[0].auto_merged).toBeUndefined();
    expect(a.results[0].node_id).not.toBe(b.results[0].node_id);

    // Both should exist independently
    expect(stateTree.getNode(a.results[0].node_id)).not.toBeNull();
    expect(stateTree.getNode(b.results[0].node_id)).not.toBeNull();
  });

  it('merges properties (new wins) and takes max of confidences on auto-merge', () => {
    const first = stateTree.mutate([
      { op: 'create', type: 'concept', name: 'GraphDB',
        properties: { keep: 'original', overwrite: 'old' },
        confidence: 0.5 },
    ]);
    const firstId = first.results[0].node_id;

    const second = stateTree.mutate([
      { op: 'create', type: 'concept', name: 'GraphDB',
        properties: { overwrite: 'new', extra: 'added' },
        confidence: 0.9 },
    ]);

    expect(second.results[0].auto_merged).toBe(true);
    const node = stateTree.getNode(firstId)!;
    expect(node.properties).toEqual({
      keep: 'original',
      overwrite: 'new',
      extra: 'added',
    });
    expect(node.confidence).toBe(0.9);

    // Third create with LOWER confidence → should not drop confidence below existing max
    const third = stateTree.mutate([
      { op: 'create', type: 'concept', name: 'GraphDB', confidence: 0.3 },
    ]);
    expect(third.results[0].auto_merged).toBe(true);
    const after = stateTree.getNode(firstId)!;
    expect(after.confidence).toBe(0.9);
  });

  it('auto-merges intra-batch duplicate creates in the same mutate() call', () => {
    // Both creates land in one transaction — the second must see the first
    // (not yet committed to the DB) and merge into it, otherwise we'd produce
    // two rows for one concept.
    const res = stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram', properties: { a: 1 } },
      { op: 'create', type: 'project', name: 'engram', properties: { b: 2 } },
    ]);

    expect(res.results).toHaveLength(2);
    expect(res.results[0].auto_merged).toBeUndefined();
    expect(res.results[1].auto_merged).toBe(true);
    expect(res.results[1].matched_by).toBe('exact');
    expect(res.results[1].node_id).toBe(res.results[0].node_id);

    // Exactly one project-typed node for this concept
    const all = stateTree.getNodesByType('project');
    const engramNodes = all.filter(n => n.name.toLowerCase() === 'engram');
    expect(engramNodes).toHaveLength(1);
    expect(engramNodes[0]!.properties).toEqual({ a: 1, b: 2 });
  });

  it('records auto_merges in the event log for audit', () => {
    stateTree.mutate([
      { op: 'create', type: 'project', name: 'Engram' },
    ]);
    const { event_id } = stateTree.mutate([
      { op: 'create', type: 'project', name: 'engram', properties: { x: 1 } },
    ]);

    const ev = eventLog.queryByType('mutation').find(e => e.id === event_id);
    expect(ev).toBeDefined();
    const content = ev!.content as { auto_merges?: Array<{ matched_by: string; requested_name: string }> };
    expect(content.auto_merges).toBeDefined();
    expect(content.auto_merges!).toHaveLength(1);
    expect(content.auto_merges![0]!.requested_name).toBe('engram');
    expect(content.auto_merges![0]!.matched_by).toBe('exact');
  });

  it('mutate() uses an IMMEDIATE transaction (concurrent-write race guard)', () => {
    // Open a SECOND connection to the same DB file and acquire a write lock
    // via BEGIN IMMEDIATE. If our mutate() uses IMMEDIATE too it should fail
    // to acquire the lock (SQLITE_BUSY) — proving the txn tries to take the
    // write lock upfront, not lazily. If mutate() were DEFERRED the BEGIN
    // would succeed and only the INSERT would fail, which is the race we're
    // trying to close.
    const otherDb = new Database(TEST_DB_PATH);
    otherDb.pragma('busy_timeout = 0');
    db.pragma('busy_timeout = 0');
    otherDb.prepare('BEGIN IMMEDIATE').run();

    try {
      let caught: unknown = null;
      try {
        stateTree.mutate([
          { op: 'create', type: 'project', name: 'Race Test' },
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(String(caught)).toMatch(/SQLITE_BUSY|database is locked/i);
    } finally {
      otherDb.prepare('ROLLBACK').run();
      otherDb.close();
    }
  });
});
