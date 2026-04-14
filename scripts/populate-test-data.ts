/* eslint-disable no-console */
/**
 * Populates a test graph for manual E2E verification.
 * Usage: ENGRAM_DATA_DIR=/tmp/engram-test npx tsx scripts/populate-test-data.ts
 */
import { createEngramCore } from '../src/service.js';

const core = createEngramCore();

console.log('Creating nodes...');
const { results: nodes } = core.stateTree.mutate([
  { op: 'create', type: 'person', name: 'Alice',
    properties: { role: 'senior engineer', team: 'platform' },
    summary: 'Senior platform engineer, leads Engram project' },
  { op: 'create', type: 'person', name: 'Bob',
    properties: { role: 'designer' }, summary: 'UX designer' },
  { op: 'create', type: 'person', name: 'Charlie',
    properties: { role: 'pm' } },
  { op: 'create', type: 'project', name: 'Engram',
    properties: { status: 'active', domain: 'AI' },
    summary: 'AI-native memory system — MCP + CLI + REST' },
  { op: 'create', type: 'project', name: 'Atlas',
    properties: { status: 'planning' } },
  { op: 'create', type: 'concept', name: 'TypeScript',
    properties: { category: 'language' }, summary: 'Typed JavaScript' },
  { op: 'create', type: 'concept', name: 'SQLite',
    properties: { category: 'database' } },
  { op: 'create', type: 'rule', name: 'no-markdown-memory',
    summary: 'Memory must be structured state, not markdown files' },
]);

const [alice, bob, charlie, engram, atlas, ts, sqlite, rule] = nodes;

console.log('Linking entities...');
core.stateTree.link([
  { op: 'create', source_id: alice.node_id, predicate: 'works_on', target_id: engram.node_id },
  { op: 'create', source_id: alice.node_id, predicate: 'leads', target_id: engram.node_id },
  { op: 'create', source_id: bob.node_id, predicate: 'works_on', target_id: engram.node_id },
  { op: 'create', source_id: charlie.node_id, predicate: 'manages', target_id: atlas.node_id },
  { op: 'create', source_id: alice.node_id, predicate: 'knows', target_id: bob.node_id },
  { op: 'create', source_id: alice.node_id, predicate: 'prefers', target_id: ts.node_id },
  { op: 'create', source_id: engram.node_id, predicate: 'uses', target_id: ts.node_id },
  { op: 'create', source_id: engram.node_id, predicate: 'uses', target_id: sqlite.node_id },
  { op: 'create', source_id: engram.node_id, predicate: 'enforces', target_id: rule.node_id },
]);

console.log('Logging observation event...');
core.eventLog.append({
  type: 'observation',
  source: 'user',
  session_id: 'test-session',
  content: { note: 'Alice was promoted to lead engineer on 2026-04-01' },
});

console.log('Updating Alice (version bump + history snapshot)...');
core.stateTree.mutate([
  { op: 'update', node_id: alice.node_id,
    set: { role: 'lead engineer' },
    summary: 'Lead platform engineer, owns Engram architecture' },
]);

const stats = core.db
  .prepare('SELECT COUNT(*) as n FROM nodes').get() as { n: number };
const edgeCount = core.db
  .prepare('SELECT COUNT(*) as n FROM edges').get() as { n: number };
const eventCount = core.db
  .prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
const historyCount = core.db
  .prepare('SELECT COUNT(*) as n FROM node_history').get() as { n: number };

console.log('\n✅ Populated:');
console.log(`  Nodes:       ${stats.n}`);
console.log(`  Edges:       ${edgeCount.n}`);
console.log(`  Events:      ${eventCount.n}`);
console.log(`  History:     ${historyCount.n}`);
console.log(`  Data dir:    ${core.config.dataDir}`);

await core.closeAsync();
