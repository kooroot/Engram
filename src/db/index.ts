import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export interface DatabaseConnection {
  db: Database.Database;
  close(): void;
}

// M3: Migration tracking table
function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
    )
  `);
}

function runMigrations(db: Database.Database, migrationFiles: string[]): void {
  const dir = fs.existsSync(MIGRATIONS_DIR)
    ? MIGRATIONS_DIR
    : path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

  ensureMigrationTable(db);
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>)
      .map(r => r.name)
  );

  const insertMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const file of migrationFiles) {
    if (applied.has(file)) continue;

    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf-8');
      db.exec(sql);
      insertMigration.run(file);
    }
  }
}

/**
 * Bootstrap query-planner statistics. Without sqlite_stat1, SQLite mis-picks
 * idx_edges_namespace — a namespace-wide scan over every edge — instead of the
 * selective idx_edges_source / idx_edges_target on the hot traversal queries
 * (getEdgesFrom / getEdgesTo and expandNeighborhood's getEdgesForNodes, run on
 * every get_context). A one-time ANALYZE flips those to index seeks / a
 * multi-index OR (verified via EXPLAIN QUERY PLAN). Runs only when edges exist
 * but have no stats yet, so a fresh empty DB is never seeded with "0 rows"
 * stats that would then go stale as it grows; PRAGMA optimize on close keeps
 * them fresh thereafter.
 */
function ensurePlannerStats(db: Database.Database): void {
  const stat1Exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'")
    .get();
  if (stat1Exists) {
    const edgeStats = db.prepare("SELECT 1 FROM sqlite_stat1 WHERE tbl = 'edges'").get();
    if (edgeStats) return;
  }
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
  if (c > 0) db.exec('ANALYZE');
}

export function initMainDb(config: Config): DatabaseConnection {
  const dbPath = path.join(config.dataDir, config.dbFilename);

  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Read-path tuning. The hot path (get_context on every SessionStart /
  // UserPromptSubmit hook) is short-lived and read-heavy:
  //   cache_size  negative = KiB ceiling; 64 MB comfortably holds the working
  //               set of a single-user memory store. Allocated lazily, so
  //               short-lived hook processes that touch a few pages stay small.
  //   mmap_size   memory-map the DB file (256 MB) so reads skip the read()
  //               syscall + page copy — the whole DB maps for typical sizes.
  //   temp_store  keep temp b-trees (FTS rank sorts, dedup GROUP BY) in RAM.
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  runMigrations(db, [
    '001_init_events.sql',
    '002_init_state_tree.sql',
    '003_init_node_history.sql',
    '005_add_namespaces.sql',
    '007_add_fts5.sql',
    '008_namespace_scope_fixes.sql',
    '009_add_usage_log.sql',
    '010_drop_redundant_indexes.sql',
  ]);

  ensurePlannerStats(db);

  return {
    db,
    close() {
      // Refresh planner stats for tables this connection materially changed.
      // Cheap no-op when nothing changed (e.g. read-only hook processes).
      try { db.pragma('optimize'); } catch { /* best-effort */ }
      db.close();
    },
  };
}

export function initVecDb(config: Config): DatabaseConnection {
  const dbPath = path.join(config.dataDir, config.vecDbFilename);

  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // Same read-path tuning as the main DB. Vector KNN scans benefit especially
  // from mmap (no per-page read() syscall). No foreign_keys pragma here —
  // the vec0 virtual table has no FK relationships to enforce.
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  runMigrations(db, [
    '004_init_vectors.sql',
    '006_add_vector_namespaces.sql',
  ]);

  return {
    db,
    close() {
      try { db.pragma('optimize'); } catch { /* best-effort */ }
      db.close();
    },
  };
}
