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

function runMigrations(db: Database.Database, migrationFiles: string[]): void {
  // Use compiled dist path or source path
  const dir = fs.existsSync(MIGRATIONS_DIR)
    ? MIGRATIONS_DIR
    : path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

  for (const file of migrationFiles) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf-8');
      db.exec(sql);
    }
  }
}

export function initMainDb(config: Config): DatabaseConnection {
  const dbPath = path.join(config.dataDir, config.dbFilename);

  // Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = new Database(dbPath);

  // Performance & safety settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run event log + state tree + history migrations
  runMigrations(db, [
    '001_init_events.sql',
    '002_init_state_tree.sql',
    '003_init_node_history.sql',
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

  // Run vector store migration (without sqlite-vec extension for now)
  runMigrations(db, ['004_init_vectors.sql']);

  return {
    db,
    close() {
      db.close();
    },
  };
}
