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

export function initMainDb(config: Config): DatabaseConnection {
  const dbPath = path.join(config.dataDir, config.dbFilename);

  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db, [
    '001_init_events.sql',
    '002_init_state_tree.sql',
    '003_init_node_history.sql',
    '005_add_namespaces.sql',
  ]);

  return {
    db,
    close() {
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

  runMigrations(db, [
    '004_init_vectors.sql',
    '006_add_vector_namespaces.sql',
  ]);

  return {
    db,
    close() {
      db.close();
    },
  };
}
