import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-merge.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const dir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const f of [
    '001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql',
    '005_add_namespaces.sql', '007_add_fts5.sql',
  ]) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'));
  }
  return db;
}

describe('mergeNodes', () => {
  let db: Database.Database;
  let tree: StateTree;

  beforeEach(() => {
    db = setupDb();
    tree = new StateTree(db, new EventLog(db), 'default');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('re-points outgoing edges from source to target', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'AliceA', properties: { role: 'senior' } },
      { op: 'create', type: 'person', name: 'AliceB', properties: { team: 'platform' } },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);
    const [a, b, engram] = results;
    tree.link([
      { op: 'create', source_id: a.node_id, predicate: 'works_on', target_id: engram.node_id },
    ]);

    const result = tree.mergeNodes(a.node_id, b.node_id);
    expect(result.merged_edges).toBe(1);

    const bOut = tree.getEdgesFrom(b.node_id);
    expect(bOut.length).toBe(1);
    expect(bOut[0].predicate).toBe('works_on');
    expect(bOut[0].target_id).toBe(engram.node_id);

    const aNode = tree.getNode(a.node_id);
    expect(aNode?.archived).toBe(true);
  });

  it('re-points incoming edges', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'Bob' },
      { op: 'create', type: 'project', name: 'ProjectA' },
      { op: 'create', type: 'project', name: 'ProjectB' },
    ]);
    const [bob, pA, pB] = results;
    tree.link([
      { op: 'create', source_id: bob.node_id, predicate: 'works_on', target_id: pA.node_id },
    ]);

    tree.mergeNodes(pA.node_id, pB.node_id);

    const bobOut = tree.getEdgesFrom(bob.node_id);
    expect(bobOut[0].target_id).toBe(pB.node_id);
  });

  it('deduplicates edges already present on target', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'AliceA' },
      { op: 'create', type: 'person', name: 'AliceB' },
      { op: 'create', type: 'project', name: 'Engram' },
    ]);
    const [a, b, engram] = results;
    tree.link([
      { op: 'create', source_id: a.node_id, predicate: 'works_on', target_id: engram.node_id },
      { op: 'create', source_id: b.node_id, predicate: 'works_on', target_id: engram.node_id },
    ]);

    const result = tree.mergeNodes(a.node_id, b.node_id);
    expect(result.dedup_edges).toBe(1);

    const bOut = tree.getEdgesFrom(b.node_id);
    expect(bOut.length).toBe(1);
  });

  it('merges properties with target winning conflicts', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'AliceA',
        properties: { role: 'senior', level: 'L5', hobby: 'music' } },
      { op: 'create', type: 'person', name: 'AliceB',
        properties: { role: 'lead', team: 'platform' } },
    ]);
    const [a, b] = results;
    tree.mergeNodes(a.node_id, b.node_id);

    const merged = tree.getNode(b.node_id);
    expect(merged?.properties).toEqual({
      role: 'lead', team: 'platform', level: 'L5', hobby: 'music',
    });
  });

  it('uses source summary if target has none', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'A', summary: 'Source summary' },
      { op: 'create', type: 'person', name: 'B' },
    ]);
    tree.mergeNodes(results[0].node_id, results[1].node_id);
    expect(tree.getNode(results[1].node_id)?.summary).toBe('Source summary');
  });

  it('throws when merging a node with itself', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
    ]);
    expect(() => tree.mergeNodes(results[0].node_id, results[0].node_id))
      .toThrow(/itself/);
  });

  it('throws when source or target not found', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'Alice' },
    ]);
    expect(() => tree.mergeNodes('nope', results[0].node_id)).toThrow(/not found/);
    expect(() => tree.mergeNodes(results[0].node_id, 'nope')).toThrow(/not found/);
  });

  it('snapshots target before merge', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'person', name: 'A', properties: { x: 1 } },
      { op: 'create', type: 'person', name: 'B', properties: { y: 2 } },
    ]);
    tree.mergeNodes(results[0].node_id, results[1].node_id);

    const history = db
      .prepare('SELECT * FROM node_history WHERE node_id = ?')
      .all(results[1].node_id) as Array<{ properties: string }>;
    expect(history.length).toBe(1);
    expect(JSON.parse(history[0].properties)).toEqual({ y: 2 });
  });
});
