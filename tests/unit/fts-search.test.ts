import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-fts.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of [
    '001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql',
    '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql',
  ]) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

describe('FTS5 keyword search', () => {
  let db: Database.Database;
  let stateTree: StateTree;

  beforeEach(() => {
    db = setupDb();
    stateTree = new StateTree(db, new EventLog(db, 'default'), 'default');
    stateTree.mutate([
      { op: 'create', type: 'person', name: 'Alice Chen',
        properties: { role: 'senior engineer' }, summary: 'Platform team lead' },
      { op: 'create', type: 'person', name: 'Bob Kim',
        properties: { role: 'designer' }, summary: 'UX specialist focused on accessibility' },
      { op: 'create', type: 'project', name: 'Engram',
        summary: 'AI-native memory system built on SQLite' },
      { op: 'create', type: 'concept', name: 'TypeScript',
        summary: 'A typed superset of JavaScript' },
    ]);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('matches on node name', () => {
    const results = stateTree.searchFts('Alice*');
    expect(results.map(n => n.name)).toContain('Alice Chen');
  });

  it('matches on type', () => {
    const results = stateTree.searchFts('person*');
    const names = results.map(n => n.name);
    expect(names).toContain('Alice Chen');
    expect(names).toContain('Bob Kim');
  });

  it('matches on summary content', () => {
    const results = stateTree.searchFts('accessibility*');
    expect(results.map(n => n.name)).toContain('Bob Kim');
  });

  it('matches on properties JSON', () => {
    const results = stateTree.searchFts('designer*');
    expect(results.map(n => n.name)).toContain('Bob Kim');
  });

  it('supports OR query', () => {
    const results = stateTree.searchFts('Alice* OR Bob*');
    const names = results.map(n => n.name);
    expect(names).toContain('Alice Chen');
    expect(names).toContain('Bob Kim');
  });

  it('supports quoted phrases', () => {
    const results = stateTree.searchFts('"team lead"');
    expect(results.map(n => n.name)).toContain('Alice Chen');
  });

  it('returns empty for no matches', () => {
    const results = stateTree.searchFts('nonexistenttermxyz');
    expect(results).toEqual([]);
  });

  it('excludes archived nodes via trigger', () => {
    const node = stateTree.getNodeByName('Alice Chen')!;
    db.prepare("UPDATE nodes SET archived = 1 WHERE id = ?").run(node.id);
    const results = stateTree.searchFts('Alice*');
    expect(results.map(n => n.name)).not.toContain('Alice Chen');
  });

  it('respects namespace isolation', () => {
    const other = new StateTree(db, new EventLog(db, 'other-ns'), 'other-ns');
    other.mutate([
      { op: 'create', type: 'person', name: 'Other Alice', summary: 'different namespace' },
    ]);

    const defaultResults = stateTree.searchFts('Alice*');
    expect(defaultResults.map(n => n.name)).not.toContain('Other Alice');
    expect(defaultResults.map(n => n.name)).toContain('Alice Chen');

    const otherResults = other.searchFts('Alice*');
    expect(otherResults.map(n => n.name)).toContain('Other Alice');
    expect(otherResults.map(n => n.name)).not.toContain('Alice Chen');
  });
});
