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
    '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql', '012_conditional_fts_triggers.sql',
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

  it('collapses a direct edge between the merged pair instead of making a self-loop', () => {
    const { results } = tree.mutate([
      { op: 'create', type: 'concept', name: 'Src' },
      { op: 'create', type: 'concept', name: 'Tgt' },
    ]);
    const [src, tgt] = results;
    // Link the two duplicates BOTH ways — exactly the shape dedup operates on.
    tree.link([
      { op: 'create', source_id: src.node_id, predicate: 'related_to', target_id: tgt.node_id },
      { op: 'create', source_id: tgt.node_id, predicate: 'is_a', target_id: src.node_id },
    ]);

    const result = tree.mergeNodes(src.node_id, tgt.node_id);

    // Both inter-duplicate edges collapse into dedup_edges; neither becomes a
    // target --> target self-loop.
    expect(result.dedup_edges).toBe(2);
    const selfLoops = [
      ...tree.getEdgesFrom(tgt.node_id),
      ...tree.getEdgesTo(tgt.node_id),
    ].filter(e => e.source_id === e.target_id);
    expect(selfLoops).toHaveLength(0);
    expect(tree.getEdgesFrom(tgt.node_id)).toHaveLength(0);
    expect(tree.getEdgesTo(tgt.node_id)).toHaveLength(0);
  });
});

describe('EventLog.append concurrency semantics (P6b)', () => {
  // better-sqlite3 is synchronous, so a true concurrent-writer race cannot be
  // reproduced in-process. These tests pin the SQLite mechanism the .immediate
  // fix relies on: a DEFERRED read-then-write upgrade fails with
  // SQLITE_BUSY_SNAPSHOT (which busy_timeout cannot retry), whereas a txn that
  // BEGINs IMMEDIATE takes the write lock up front and never hits that window.
  const DIR = path.join(import.meta.dirname, '..', '.test-data');
  const P = path.join(DIR, 'test-eventlog-concurrency.db');

  const fresh = () => {
    fs.mkdirSync(DIR, { recursive: true });
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(P + ext)) fs.unlinkSync(P + ext);
    const db = new Database(P);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1)').run();
    db.close();
  };

  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(P + ext)) fs.unlinkSync(P + ext);
  });

  // better-sqlite3 surfaces the SQLite extended result code on err.code; the
  // human-readable err.message is just "database is locked" for the whole BUSY
  // family. We assert on .code so the two cases are distinguishable.
  const codeOfThrow = (fn: () => void): string | undefined => {
    try { fn(); return undefined; }
    catch (e) { return (e as { code?: string }).code; }
  };

  it('DEFERRED read-then-write upgrade fails with SQLITE_BUSY_SNAPSHOT when a writer commits in between', () => {
    fresh();
    const a = new Database(P); a.pragma('busy_timeout = 0');
    const b = new Database(P); b.pragma('busy_timeout = 0');
    try {
      a.exec('BEGIN');                                  // DEFERRED — starts read-only
      a.prepare('SELECT v FROM t WHERE id = 1').get();  // take a read snapshot
      b.prepare('UPDATE t SET v = 2 WHERE id = 1').run(); // another connection commits
      // The snapshot-upgrade conflict: busy_timeout cannot retry SNAPSHOT, which
      // is exactly why a DEFERRED append() would fail under a concurrent writer.
      expect(codeOfThrow(() => a.prepare('UPDATE t SET v = 3 WHERE id = 1').run()))
        .toBe('SQLITE_BUSY_SNAPSHOT');
      a.exec('ROLLBACK');
    } finally {
      a.close(); b.close();
    }
  });

  it('BEGIN IMMEDIATE takes the write lock up front, so the writer never hits the snapshot window', () => {
    fresh();
    const a = new Database(P); a.pragma('busy_timeout = 0');
    const b = new Database(P); b.pragma('busy_timeout = 0');
    try {
      a.exec('BEGIN IMMEDIATE');                         // acquire write lock at BEGIN
      // b is locked out with plain SQLITE_BUSY (not SNAPSHOT) — a contention that
      // busy_timeout WOULD retry, so the IMMEDIATE writer is safe across clients.
      expect(codeOfThrow(() => b.prepare('UPDATE t SET v = 9 WHERE id = 1').run()))
        .toBe('SQLITE_BUSY');
      a.prepare('UPDATE t SET v = 3 WHERE id = 1').run(); // a proceeds, no snapshot conflict
      a.exec('COMMIT');
      expect((a.prepare('SELECT v FROM t WHERE id = 1').get() as { v: number }).v).toBe(3);
    } finally {
      a.close(); b.close();
    }
  });
});
