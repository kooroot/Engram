import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { findDedupClusters, runDedupPass, cosineSimilarity } from '../../src/engine/dedup-scan.js';

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

  it('re-points edges through the merge (Tier 1)', () => {
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

describe('dedup-scan cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it('returns -1 for antiparallel vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('returns 0 for length mismatch', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
  it('handles non-normalized vectors correctly', () => {
    // [2,0] vs [1,0] — parallel, magnitude differs → still cos=1
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1, 5);
  });
});

describe('dedup-scan findDedupClusters with Tier 2', () => {
  let db: Database.Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('clusters semantically similar nodes that Tier 1 misses', () => {
    // Names that DON'T share tokens but should merge by meaning.
    // We supply hand-crafted "embeddings" where a and b are near-identical
    // (cos ≈ 1) but c is orthogonal (cos = 0). Type gate is still enforced.
    const a = rawInsertNode(db, 'default', { type: 'concept', name: 'Authentication' });
    const b = rawInsertNode(db, 'default', { type: 'concept', name: 'Login flow' });
    const c = rawInsertNode(db, 'default', { type: 'concept', name: 'Database schema' });

    const embeddings: Record<string, Float32Array> = {
      [a]: new Float32Array([1.0, 0.0, 0.0]),
      [b]: new Float32Array([0.99, 0.14, 0.0]), // cos(a,b) ≈ 0.99
      [c]: new Float32Array([0.0, 0.0, 1.0]),
    };

    const clusters = findDedupClusters(db, 'default', {
      getEmbedding: (id) => embeddings[id] ?? null,
      threshold: 0.9,
    });

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    // a+b clustered, c excluded
    const allIds = [cluster.target_id, ...cluster.sources.map(s => s.id)];
    expect(allIds).toContain(a);
    expect(allIds).toContain(b);
    expect(allIds).not.toContain(c);
    // The source was matched via 'semantic'
    expect(cluster.sources[0]!.matched_by).toBe('semantic');
    expect(cluster.sources[0]!.score).toBeGreaterThanOrEqual(0.9);
  });

  it('respects Tier 2 type gate', () => {
    // Same semantic vectors but different types → no cluster
    const a = rawInsertNode(db, 'default', { type: 'concept', name: 'Auth' });
    const b = rawInsertNode(db, 'default', { type: 'project', name: 'Login' });
    const embeddings: Record<string, Float32Array> = {
      [a]: new Float32Array([1.0, 0.0]),
      [b]: new Float32Array([1.0, 0.0]), // cos = 1 but types differ
    };
    const clusters = findDedupClusters(db, 'default', {
      getEmbedding: (id) => embeddings[id] ?? null,
      threshold: 0.9,
    });
    expect(clusters).toEqual([]);
  });

  it('combines Tier 1 and Tier 2 matches into one cluster (connected components)', () => {
    // a↔b: Tier 1 (substring)
    // b↔c: Tier 2 (semantic, unrelated names)
    // Expected: all three in one cluster
    const a = rawInsertNode(db, 'default', { type: 'concept', name: 'auth' });
    const b = rawInsertNode(db, 'default', { type: 'concept', name: 'auth flow' });
    const c = rawInsertNode(db, 'default', { type: 'concept', name: 'sign-in path' });
    const embeddings: Record<string, Float32Array> = {
      [a]: new Float32Array([1.0, 0.0]),
      [b]: new Float32Array([0.8, 0.6]),
      [c]: new Float32Array([0.81, 0.59]), // very close to b
    };
    const clusters = findDedupClusters(db, 'default', {
      getEmbedding: (id) => embeddings[id] ?? null,
      threshold: 0.95,
    });
    expect(clusters).toHaveLength(1);
    const allIds = new Set([clusters[0]!.target_id, ...clusters[0]!.sources.map(s => s.id)]);
    expect(allIds.size).toBe(3);
    expect(allIds.has(a)).toBe(true);
    expect(allIds.has(b)).toBe(true);
    expect(allIds.has(c)).toBe(true);
  });

  it('skips Tier 2 pair when either embedding is missing (no false positive)', () => {
    const a = rawInsertNode(db, 'default', { type: 'concept', name: 'Auth' });
    const b = rawInsertNode(db, 'default', { type: 'concept', name: 'Login' });
    const embeddings: Record<string, Float32Array> = {
      [a]: new Float32Array([1.0, 0.0]),
      // b has no embedding
    };
    const clusters = findDedupClusters(db, 'default', {
      getEmbedding: (id) => embeddings[id] ?? null,
      threshold: 0.5,
    });
    expect(clusters).toEqual([]);
  });
});
