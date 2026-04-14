import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { traverseGraph } from '../../src/engine/graph-traversal.js';
import { seedTestGraph } from '../fixtures/seed-data.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-traversal.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of ['001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql', '005_add_namespaces.sql', '007_add_fts5.sql']) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

describe('Graph Traversal', () => {
  let db: Database.Database;
  let stateTree: StateTree;
  let nodeIds: ReturnType<typeof seedTestGraph>;

  beforeEach(() => {
    db = setupDb();
    stateTree = new StateTree(db, new EventLog(db));
    nodeIds = seedTestGraph(stateTree);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should traverse 1-hop outgoing from Alice', () => {
    const result = traverseGraph(stateTree, {
      from: nodeIds.alice.node_id,
      direction: 'outgoing',
      depth: 1,
    });
    const names = result.nodes.map(n => n.name).sort();
    expect(names).toContain('Alice');
    expect(names).toContain('Engram');
    expect(names).toContain('Bob');
    expect(names).toContain('TypeScript');
    expect(result.edges).toHaveLength(3);
  });

  it('should traverse 2-hop outgoing from Alice', () => {
    const result = traverseGraph(stateTree, {
      from: nodeIds.alice.node_id,
      direction: 'outgoing',
      depth: 2,
    });
    const names = result.nodes.map(n => n.name);
    expect(names).toContain('Charlie');
    expect(names).toContain('Project');
    expect(names).toContain('Language');
    expect(result.meta.depth_reached).toBe(2);
  });

  it('should filter by predicate', () => {
    const result = traverseGraph(stateTree, {
      from: nodeIds.alice.node_id,
      direction: 'outgoing',
      depth: 1,
      predicates: ['works_on'],
    });
    const names = result.nodes.map(n => n.name);
    expect(names).toContain('Engram');
    expect(names).not.toContain('Bob');
    expect(names).not.toContain('TypeScript');
  });

  it('should traverse incoming edges', () => {
    const result = traverseGraph(stateTree, {
      from: nodeIds.engram.node_id,
      direction: 'incoming',
      depth: 1,
    });
    const names = result.nodes.map(n => n.name);
    expect(names).toContain('Alice');
    expect(names).toContain('Bob');
  });

  it('should handle non-existent node', () => {
    const result = traverseGraph(stateTree, {
      from: 'non-existent-id',
      direction: 'both',
      depth: 1,
    });
    expect(result.nodes).toHaveLength(0);
    expect(result.meta.total_nodes).toBe(0);
  });

  it('should resolve node by name', () => {
    const result = traverseGraph(stateTree, {
      from: 'Alice',
      direction: 'outgoing',
      depth: 1,
    });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes[0].name).toBe('Alice');
  });

  it('should detect cycles and not revisit nodes', () => {
    stateTree.link([
      { op: 'create', source_id: nodeIds.bob.node_id, predicate: 'reports_to', target_id: nodeIds.alice.node_id },
    ]);
    const result = traverseGraph(stateTree, {
      from: nodeIds.alice.node_id,
      direction: 'outgoing',
      depth: 3,
    });
    const aliceCount = result.nodes.filter(n => n.name === 'Alice').length;
    expect(aliceCount).toBe(1);
  });

  it('should cap depth at 5', () => {
    const result = traverseGraph(stateTree, {
      from: nodeIds.alice.node_id,
      direction: 'both',
      depth: 100,
    });
    expect(result.meta.depth_reached).toBeLessThanOrEqual(5);
  });
});
