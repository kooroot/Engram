import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../../src/db/event-log.js';
import { StateTree } from '../../src/db/state-tree.js';
import { traverseGraph } from '../../src/engine/graph-traversal.js';
import { buildContext, estimateTokens } from '../../src/engine/context-builder.js';
import { seedTestGraph } from '../fixtures/seed-data.js';
import type { Node, Edge } from '../../src/types/index.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '.test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-context.db');

function setupDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations');
  for (const file of ['001_init_events.sql', '002_init_state_tree.sql', '003_init_node_history.sql', '005_add_namespaces.sql', '007_add_fts5.sql', '008_namespace_scope_fixes.sql']) {
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

  it('should cap nodes per type with maxPerType', () => {
    // 5 distinct-named decisions (no auto-dedup) + 1 project, descending confidence.
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const ids = names.map((n, i) => {
      const { results } = stateTree.mutate([
        { op: 'create', type: 'decision', name: n, summary: `decision ${n}`, confidence: 0.9 - i * 0.01 },
      ]);
      return results[0].node_id;
    });
    const { results: proj } = stateTree.mutate([
      { op: 'create', type: 'project', name: 'ProjX', summary: 'the project', confidence: 0.99 },
    ]);
    const nodes = [...ids, proj[0].node_id].map(id => stateTree.getNode(id)!);

    const ctx = buildContext(nodes, [], { maxTokens: 5000, maxPerType: 2 });
    const decisionHeaders = ctx.split('\n').filter(l => l.includes('[decision]'));
    expect(decisionHeaders).toHaveLength(2);   // only top-2 highest-confidence decisions
    expect(ctx).toContain('## Alpha [decision]');
    expect(ctx).toContain('## Beta [decision]');
    expect(ctx).not.toContain('Epsilon');      // lowest-confidence decision dropped
    expect(ctx).toContain('## ProjX [project]'); // other types unaffected by the cap
  });

  it('should estimate tokens correctly', () => {
    // L2: Updated to ~3.3 chars per token for JSON-heavy content
    expect(estimateTokens('hello world')).toBe(4); // 11 / 3.3 ≈ 3.33 → ceil = 4
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(330))).toBe(100); // 330 / 3.3 = 100
  });
});

describe('Context Builder — budget loop & edge cap (P6)', () => {
  let seq = 0;
  const TS = '2026-01-01T00:00:00.000';
  const mkNode = (o: Partial<Node> & { name: string }): Node => ({
    id: o.id ?? `n${seq++}`, type: o.type ?? 'concept', name: o.name,
    properties: o.properties ?? {}, summary: o.summary ?? null,
    confidence: o.confidence ?? 1.0, created_at: TS, updated_at: o.updated_at ?? TS,
    version: 1, archived: false, event_id: null,
  });
  const mkEdge = (source_id: string, target_id: string, o: Partial<Edge> = {}): Edge => ({
    id: o.id ?? `e${seq++}`, source_id, predicate: o.predicate ?? 'relates_to', target_id,
    properties: {}, confidence: o.confidence ?? 1.0, created_at: TS, updated_at: o.updated_at ?? TS,
    version: 1, archived: false, event_id: null,
  });

  it('keeps fitting smaller nodes after an oversized one (no early break)', () => {
    // 660-char budget. The first (highest-confidence) node overflows it; the
    // loop must CONTINUE, not break, or the two small nodes vanish entirely.
    const big = mkNode({ id: 'big', name: 'Big', confidence: 1.0, summary: 'X'.repeat(800) });
    const s1 = mkNode({ id: 's1', name: 'SmallOne', confidence: 0.9, summary: 'tiny' });
    const s2 = mkNode({ id: 's2', name: 'SmallTwo', confidence: 0.8, summary: 'tiny' });

    const ctx = buildContext([big, s1, s2], [], { maxTokens: 200 });

    expect(ctx).toContain('## Big [concept]');
    expect(ctx).toContain('(truncated)');
    expect(ctx).toContain('## SmallOne [concept]'); // would be dropped by the old `break`
    expect(ctx).toContain('## SmallTwo [concept]');
  });

  it('caps edges per direction and summarizes the remainder as (+N more)', () => {
    const hub = mkNode({ id: 'hub', name: 'Hub' });
    const targets = Array.from({ length: 12 }, (_, i) => mkNode({ id: `t${i}`, name: `T${i}` }));
    const edges = targets.map(t => mkEdge('hub', t.id));

    const ctx = buildContext([hub, ...targets], edges, { maxTokens: 100_000 });

    const outLines = ctx.split('\n').filter(l => l.startsWith('-> ') && !l.includes('more'));
    expect(outLines).toHaveLength(8);        // MAX_EDGES_PER_DIRECTION
    expect(ctx).toContain('-> (+4 more)');   // 12 − 8 elided
  });
});
