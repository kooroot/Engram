import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { traverseGraph } from '../../src/engine/graph-traversal.js';
import { buildContext, estimateTokens } from '../../src/engine/context-builder.js';
import { seedTestGraph } from '../fixtures/seed-data.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-context.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of ['001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql']) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

describe('Context Builder', () => {
  let db: Database.Database;
  let stateTree: StateTree;

  beforeEach(() => {
    db = setupDb();
    stateTree = new StateTree(db, new EventLog(db));
    seedTestGraph(stateTree);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should build context from a traversal result', () => {
    const traversal = traverseGraph(stateTree, {
      from: 'Alice',
      direction: 'outgoing',
      depth: 1,
    });
    const context = buildContext(traversal.nodes, traversal.edges);
    expect(context).toContain('Alice');
    expect(context).toContain('[person]');
    expect(context).toContain('works_on');
    expect(context).toContain('Engram');
  });

  it('should use summary field when available', () => {
    const traversal = traverseGraph(stateTree, {
      from: 'Alice',
      direction: 'outgoing',
      depth: 0,
    });
    const context = buildContext(traversal.nodes, []);
    expect(context).toContain('Senior engineer, team lead');
  });

  it('should respect maxTokens budget', () => {
    const traversal = traverseGraph(stateTree, {
      from: 'Alice',
      direction: 'both',
      depth: 3,
    });
    const smallContext = buildContext(traversal.nodes, traversal.edges, { maxTokens: 50 });
    const tokens = estimateTokens(smallContext);
    expect(tokens).toBeLessThanOrEqual(60);
  });

  it('should sort by confidence (highest first)', () => {
    const alice = stateTree.getNodeByName('Alice')!;
    stateTree.mutate([
      { op: 'update', node_id: alice.id, confidence: 0.5 },
    ]);
    const traversal = traverseGraph(stateTree, {
      from: alice.id,
      direction: 'outgoing',
      depth: 1,
    });
    const context = buildContext(traversal.nodes, traversal.edges);
    const lines = context.split('\n');
    const firstNodeLine = lines.find(l => l.startsWith('##'));
    expect(firstNodeLine).not.toContain('Alice');
  });

  it('should estimate tokens correctly', () => {
    // L2: Updated to ~3.3 chars per token for JSON-heavy content
    expect(estimateTokens('hello world')).toBe(4); // 11 / 3.3 ≈ 3.33 → ceil = 4
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(330))).toBe(100); // 330 / 3.3 = 100
  });
});
