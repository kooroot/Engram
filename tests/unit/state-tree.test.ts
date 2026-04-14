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
});
