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
    '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql', '012_conditional_fts_triggers.sql',
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

  // 012: the AFTER UPDATE trigger only re-indexes when FTS-relevant columns
  // change, and deletes by rowid. Lock the sync semantics down.
  describe('conditional FTS trigger (012)', () => {
    it('metadata-only update (confidence) keeps the FTS row searchable', () => {
      const node = stateTree.getNodeByName('Alice Chen')!;
      db.prepare('UPDATE nodes SET confidence = 0.42 WHERE id = ?').run(node.id);
      expect(stateTree.searchFts('Alice*').map(n => n.name)).toContain('Alice Chen');
      // exactly one FTS row (no duplicate re-index)
      const c = db.prepare('SELECT COUNT(*) AS c FROM nodes_fts WHERE id = ?').get(node.id) as { c: number };
      expect(c.c).toBe(1);
    });

    it('rename re-indexes: old name stops matching, new name matches', () => {
      const node = stateTree.getNodeByName('Alice Chen')!;
      stateTree.mutate([{ op: 'update', node_id: node.id, name: 'Alicia Chen' }]);
      expect(stateTree.searchFts('Alicia*').map(n => n.name)).toContain('Alicia Chen');
      expect(stateTree.searchFts('"Alice Chen"')).toEqual([]);
    });

    it('summary update re-indexes new content', () => {
      const node = stateTree.getNodeByName('Bob Kim')!;
      stateTree.mutate([{ op: 'update', node_id: node.id, summary: 'moved to platform quokka team' }]);
      expect(stateTree.searchFts('quokka').map(n => n.name)).toContain('Bob Kim');
    });

    it('unarchive re-adds the FTS row', () => {
      const node = stateTree.getNodeByName('Alice Chen')!;
      db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(node.id);
      expect(stateTree.searchFts('Alice*')).toEqual([]);
      db.prepare('UPDATE nodes SET archived = 0 WHERE id = ?').run(node.id);
      expect(stateTree.searchFts('Alice*').map(n => n.name)).toContain('Alice Chen');
    });

    it('node delete removes the FTS row', () => {
      const node = stateTree.getNodeByName('Alice Chen')!;
      stateTree.mutate([{ op: 'delete', node_id: node.id }]);
      expect(stateTree.searchFts('Alice*')).toEqual([]);
      const c = db.prepare('SELECT COUNT(*) AS c FROM nodes_fts WHERE id = ?').get(node.id) as { c: number };
      expect(c.c).toBe(0);
    });

    it('FTS rowids mirror nodes rowids after the 012 rebuild', () => {
      const rows = db.prepare(`
        SELECT n.rowid AS nrow, f.rowid AS frow
        FROM nodes n JOIN nodes_fts f ON f.id = n.id
        WHERE n.archived = 0
      `).all() as Array<{ nrow: number; frow: number }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.frow).toBe(r.nrow);
    });
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
