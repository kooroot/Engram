import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { findDedupClusters, runDedupPass } from '../../src/engine/dedup-scan.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-dedup-scan.db');

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

function rawInsertNode(
  db: Database.Database,
  namespace: string,
  opts: { type: string; name: string; confidence?: number; createdAt?: string; propsJson?: string },
): string {
  const id = ulid();
  db.prepare(
    "INSERT INTO nodes (id, type, name, properties, summary, confidence, created_at, updated_at, namespace) " +
    "VALUES (?, ?, ?, ?, NULL, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%f','now')), " +
    "strftime('%Y-%m-%dT%H:%M:%f','now'), ?)"
  ).run(
    id,
    opts.type,
    opts.name,
    opts.propsJson ?? '{}',
    opts.confidence ?? 1.0,
    opts.createdAt ?? null,
    namespace,
  );
  return id;
}

describe('dedup-scan findDedupClusters', () => {
  let db: Database.Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('returns empty when no duplicates exist', () => {
    rawInsertNode(db, 'default', { type: 'project', name: 'Alpha' });
    rawInsertNode(db, 'default', { type: 'project', name: 'Beta' });
    expect(findDedupClusters(db, 'default')).toEqual([]);
  });

  it('clusters exact-match duplicates', () => {
    const id1 = rawInsertNode(db, 'default', { type: 'project', name: 'Engram', confidence: 1.0 });
    const id2 = rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 0.7 });

    const clusters = findDedupClusters(db, 'default');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.type).toBe('project');
    expect(clusters[0]!.target_id).toBe(id1);
    expect(clusters[0]!.sources).toHaveLength(1);
    expect(clusters[0]!.sources[0]!.id).toBe(id2);
    expect(clusters[0]!.sources[0]!.matched_by).toBe('exact');
  });

  it('picks earliest created_at as target when confidences tie', () => {
    const older = rawInsertNode(db, 'default', {
      type: 'project', name: 'Engram',
      confidence: 1.0, createdAt: '2026-01-01T00:00:00.000',
    });
    const newer = rawInsertNode(db, 'default', {
      type: 'project', name: 'engram',
      confidence: 1.0, createdAt: '2026-04-20T00:00:00.000',
    });

    const clusters = findDedupClusters(db, 'default');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.target_id).toBe(older);
    expect(clusters[0]!.sources[0]!.id).toBe(newer);
  });

  it('clusters via token-subset (not raw substring)', () => {
    const a = rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 1.0 });
    const b = rawInsertNode(db, 'default', {
      type: 'project', name: 'Engram Twin Mode', confidence: 0.5,
    });
    const clusters = findDedupClusters(db, 'default');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.target_id).toBe(a);
    expect(clusters[0]!.sources[0]!.id).toBe(b);
    expect(clusters[0]!.sources[0]!.matched_by).toBe('substring');
  });

  it('does NOT cluster Bot vs Robotics (token-subset guard)', () => {
    rawInsertNode(db, 'default', { type: 'concept', name: 'Bot' });
    rawInsertNode(db, 'default', { type: 'concept', name: 'Robotics' });
    expect(findDedupClusters(db, 'default')).toEqual([]);
  });

  it('respects type gate', () => {
    rawInsertNode(db, 'default', { type: 'project', name: 'bun' });
    rawInsertNode(db, 'default', { type: 'preference', name: 'bun' });
    expect(findDedupClusters(db, 'default')).toEqual([]);
  });

  it('ignores archived nodes', () => {
    const kept = rawInsertNode(db, 'default', { type: 'project', name: 'Engram', confidence: 1.0 });
    const archivedId = rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 0.7 });
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ? AND namespace = ?')
      .run(archivedId, 'default');
    expect(findDedupClusters(db, 'default')).toEqual([]);
    expect(db.prepare('SELECT id FROM nodes WHERE id = ?').get(kept)).toBeDefined();
  });

  it('forms a connected component across transitive matches', () => {
    // Union-find chain: a↔b via {engram,core} ⊂ {engram,core,system};
    // b↔c via {engram,core} ⊂ {engram,core,feature}. a and c don't match directly
    // (Jaccard 0.5 < 0.7), but transitively they're the same concept.
    rawInsertNode(db, 'default', { type: 'project', name: 'engram core system', confidence: 1.0 });
    rawInsertNode(db, 'default', { type: 'project', name: 'engram core', confidence: 0.8 });
    rawInsertNode(db, 'default', { type: 'project', name: 'engram core feature', confidence: 0.5 });
    const clusters = findDedupClusters(db, 'default');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sources).toHaveLength(2);
  });

  it('is namespace-scoped', () => {
    rawInsertNode(db, 'default', { type: 'project', name: 'Engram' });
    rawInsertNode(db, 'default', { type: 'project', name: 'engram' });
    rawInsertNode(db, 'other',   { type: 'project', name: 'Engram' });
    rawInsertNode(db, 'other',   { type: 'project', name: 'engram' });

    const defClusters = findDedupClusters(db, 'default');
    const otherClusters = findDedupClusters(db, 'other');
    expect(defClusters).toHaveLength(1);
    expect(otherClusters).toHaveLength(1);
    expect(defClusters[0]!.target_id).not.toBe(otherClusters[0]!.target_id);
  });
});

describe('dedup-scan runDedupPass', () => {
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

  it('dry-run reports clusters without changing state', () => {
    rawInsertNode(db, 'default', { type: 'project', name: 'Engram', confidence: 1.0 });
    rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 0.7 });
    const report = runDedupPass(db, 'default', (s, t) => tree.mergeNodes(s, t), true);
    expect(report.clusters).toHaveLength(1);
    expect(report.merged_count).toBe(0);
    const active = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE archived = 0').get() as { c: number };
    expect(active.c).toBe(2);
  });

  it('actual run merges sources into target and archives the sources', () => {
    const target = rawInsertNode(db, 'default', { type: 'project', name: 'Engram', confidence: 1.0 });
    const source = rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 0.7 });

    const report = runDedupPass(db, 'default', (s, t) => tree.mergeNodes(s, t), false);
    expect(report.clusters).toHaveLength(1);
    expect(report.merged_count).toBe(1);
    expect(report.failed).toEqual([]);

    const targetRow = db.prepare('SELECT archived FROM nodes WHERE id = ?').get(target) as { archived: number };
    const sourceRow = db.prepare('SELECT archived FROM nodes WHERE id = ?').get(source) as { archived: number };
    expect(targetRow.archived).toBe(0);
    expect(sourceRow.archived).toBe(1);
  });

  it('re-points edges through the merge', () => {
    const target = rawInsertNode(db, 'default', { type: 'project', name: 'Engram', confidence: 1.0 });
    const source = rawInsertNode(db, 'default', { type: 'project', name: 'engram', confidence: 0.7 });
    const person = rawInsertNode(db, 'default', { type: 'person', name: 'Alice' });

    tree.link([
      { op: 'create', source_id: person, predicate: 'works_on', target_id: source },
    ]);

    runDedupPass(db, 'default', (s, t) => tree.mergeNodes(s, t), false);

    const edge = db.prepare(
      'SELECT source_id, target_id FROM edges WHERE source_id = ? AND predicate = ? LIMIT 1'
    ).get(person, 'works_on') as { source_id: string; target_id: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.target_id).toBe(target);
  });
});
