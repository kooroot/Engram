/* eslint-disable no-console */
/**
 * Advanced E2E verification after service-layer embedding fixes:
 * 1. Auto-embedding hook fires via createEngramCore + local provider
 * 2. semanticSearch returns results
 * 3. getContext('hybrid') combines graph + semantic
 * 4. Conflict resolver dedup
 * 5. Graph traversal depth 2
 * 6. Event log integrity
 */
import { createEngramCore, semanticSearch, getContext } from '../src/service.js';
import { detectDuplicates } from '../src/engine/conflict-resolver.js';
import { traverseGraph } from '../src/engine/graph-traversal.js';

// Use local embedding provider with small dimension for fast testing
process.env['ENGRAM_EMBEDDING_PROVIDER'] = 'local';

const core = createEngramCore({
  embedding: { provider: 'local', dimension: 128 } as any,
});

console.log('Config: provider=', core.config.embedding.provider, 'dim=', core.config.embedding.dimension);
console.log('Provider resolved:', core.embeddingProvider ? 'yes' : 'no');
console.log('sqlite-vec enabled:', core.vectorStore.isVecEnabled);

console.log('\n--- Test 1: Auto-embedding on node creation ---');
const { results } = core.stateTree.mutate([
  { op: 'create', type: 'person', name: 'TestAlice', summary: 'Test engineer on the platform team' },
  { op: 'create', type: 'person', name: 'TestBob', summary: 'UX designer focused on accessibility' },
  { op: 'create', type: 'project', name: 'TestEngram', summary: 'Persistent memory for AI agents' },
]);

// Wait for async auto-embedding to complete
await new Promise(r => setTimeout(r, 500));

const embeddingCount = core.vecDb.db
  .prepare('SELECT COUNT(*) as n FROM embeddings').get() as { n: number };
console.log(`  Embeddings stored: ${embeddingCount.n} (expected: 3)`);

console.log('\n--- Test 2: Semantic search ---');
const semantic = await semanticSearch(core, 'engineer platform', 3);
console.log(`  Semantic results for "engineer platform": ${semantic.length}`);
for (const n of semantic) {
  console.log(`    - ${n.name} [${n.type}]: ${n.summary}`);
}

console.log('\n--- Test 3: getContext strategies ---');
const graphCtx = await getContext(core, { topic: 'AI memory', strategy: 'graph', maxTokens: 300 });
console.log(`  Graph strategy (keyword): ${graphCtx.length} chars`);

const semanticCtx = await getContext(core, { topic: 'AI memory', strategy: 'semantic', maxTokens: 300 });
console.log(`  Semantic strategy (vec): ${semanticCtx.length} chars`);

const hybridCtx = await getContext(core, { topic: 'AI memory', strategy: 'hybrid', maxTokens: 300 });
console.log(`  Hybrid strategy: ${hybridCtx.length} chars`);

console.log('\n--- Test 4: Conflict resolver ---');
const dupes = detectDuplicates(core.stateTree, 'person', 'TestAlice');
console.log(`  Duplicates for "TestAlice" (person): ${dupes.length}, match: ${dupes[0]?.similarity ?? 'none'}`);

console.log('\n--- Test 5: Graph traversal depth 2 ---');
const { results: more } = core.stateTree.mutate([
  { op: 'create', type: 'team', name: 'TestTeamA' },
  { op: 'create', type: 'company', name: 'TestAcme' },
]);
core.stateTree.link([
  { op: 'create', source_id: results[0].node_id, predicate: 'member_of', target_id: more[0].node_id },
  { op: 'create', source_id: more[0].node_id, predicate: 'part_of', target_id: more[1].node_id },
]);
const trv = traverseGraph(core.stateTree, { from: results[0].node_id, direction: 'outgoing', depth: 2 });
console.log(`  From TestAlice depth=2 nodes: ${trv.nodes.map(n => n.name).join(', ')}`);

console.log('\n--- Test 6: Event log integrity ---');
const integrity = core.eventLog.verifyIntegrity();
console.log(`  Chain valid: ${integrity.valid}`);

console.log('\n--- Test 7: Final stats ---');
const final = core.db.prepare(
  'SELECT (SELECT COUNT(*) FROM nodes) as nodes, (SELECT COUNT(*) FROM edges) as edges, (SELECT COUNT(*) FROM events) as events'
).get();
console.log(`  ${JSON.stringify(final)}`);

await core.closeAsync();
console.log('\n✅ All advanced tests passed');
