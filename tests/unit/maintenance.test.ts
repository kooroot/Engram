import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { runMaintenance } from '../../src/engine/maintenance.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-maintenance.db');

// Full main-DB migration list INCLUDING 011 (last_decayed_at) — the decay
// statement references that column.
const MIGRATIONS = [
  '001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql',
  '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql',
  '009_add_usage_log.sql', '010_drop_redundant_indexes.sql',
  '011_add_last_decayed_at.sql',
];

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const dir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of MIGRATIONS) db.exec(fs.readFileSync(path.join(dir, file), 'utf-8'));
  return db;
}

// factor^days keeps a node above the 0.3 archive threshold for the day-counts we
// use, so the archive step never removes our subject mid-test.
const CFG = {
  confidenceDecayFactor: 0.95,
  archiveConfidenceThreshold: 0.3,
  archiveInactiveDays: 10,
  orphanGraceDays: 3650, // never orphan-archive in these tests
  historyKeepVersions: 0,
};

describe('runMaintenance — idempotent confidence decay (P5)', () => {
  let db: Database.Database;
  let stateTree: StateTree;

  beforeEach(() => {
    db = setupDb();
    stateTree = new StateTree(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // type 'concept' is exempt from orphan archiving, isolating decay behavior.
  const seedInactive = (daysInactive: number): string => {
    const { results } = stateTree.mutate([
      { op: 'create', type: 'concept', name: 'Stale', confidence: 1.0 },
    ]);
    const id = results[0].node_id;
    // Backdate updated_at; leave last_decayed_at NULL (never decayed). The decay
    // anchor IFNULLs to updated_at, so this node is `daysInactive` days stale.
    db.prepare(
      "UPDATE nodes SET updated_at = strftime('%Y-%m-%dT%H:%M:%f','now', ?) WHERE id = ?"
    ).run(`-${daysInactive} days`, id);
    return id;
  };

  const read = (id: string) =>
    db.prepare('SELECT confidence, updated_at, last_decayed_at FROM nodes WHERE id = ?')
      .get(id) as { confidence: number; updated_at: string; last_decayed_at: string | null };

  it('re-running maintenance the same day does NOT compound decay (idempotent)', () => {
    const id = seedInactive(15);

    const r1 = runMaintenance(db, 'default', CFG);
    expect(r1.decayed).toBe(1);
    const after1 = read(id).confidence;
    expect(after1).toBeLessThan(1.0);        // actually decayed
    expect(after1).toBeGreaterThan(0.3);     // survived the archive step

    const r2 = runMaintenance(db, 'default', CFG);
    expect(r2.decayed).toBe(0);              // nothing to decay again today
    const after2 = read(id).confidence;
    expect(after2).toBe(after1);             // confidence unchanged on re-run
  });

  it('does not advance updated_at (archive/orphan/recency windows preserved)', () => {
    const id = seedInactive(15);
    const before = read(id).updated_at;
    runMaintenance(db, 'default', CFG);
    expect(read(id).updated_at).toBe(before);
  });

  it('applies cumulative decay per elapsed day across runs', () => {
    const id = seedInactive(15);
    const after1 = (runMaintenance(db, 'default', CFG), read(id).confidence);

    // Simulate 3 more days of inactivity since the last decay; updated_at stays
    // 15d old, so MAX(updated_at, last_decayed_at) = last_decayed_at (3d ago).
    db.prepare(
      "UPDATE nodes SET last_decayed_at = strftime('%Y-%m-%dT%H:%M:%f','now','-3 days') WHERE id = ?"
    ).run(id);

    const r = runMaintenance(db, 'default', CFG);
    expect(r.decayed).toBe(1);
    const after2 = read(id).confidence;
    // One more decay of exactly factor^3 relative to the prior confidence.
    expect(after2 / after1).toBeCloseTo(0.95 ** 3, 5);
  });

  it('leaves recently-active nodes untouched (inactivity gate)', () => {
    const id = seedInactive(5); // < archiveInactiveDays (10)
    const r = runMaintenance(db, 'default', CFG);
    expect(r.decayed).toBe(0);
    expect(read(id).confidence).toBe(1.0);
    expect(read(id).last_decayed_at).toBeNull(); // never touched
  });
});
