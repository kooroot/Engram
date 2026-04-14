/* eslint-disable no-console */
/**
 * Benchmark: FTS5 vs linear JS filter at varying graph sizes.
 * Run: ENGRAM_DATA_DIR=/tmp/engram-bench npx tsx scripts/bench-fts.ts
 */
import { createEngramCore } from '../src/service.js';
import { searchNodes } from '../src/service.js';

const core = createEngramCore();
const stateTree = core.stateTree;

// Ensure fresh state
core.db.prepare('DELETE FROM nodes').run();
core.db.prepare('DELETE FROM events').run();

const sizes = [100, 1000, 10_000];

for (const n of sizes) {
  // Populate n nodes
  const ops: any[] = [];
  for (let i = 0; i < n; i++) {
    ops.push({
      op: 'create',
      type: i % 5 === 0 ? 'person' : i % 5 === 1 ? 'project' : i % 5 === 2 ? 'concept' : i % 5 === 3 ? 'rule' : 'fact',
      name: `Entity${i}`,
      properties: { domain: `domain${i % 20}`, role: i % 3 === 0 ? 'engineer' : i % 3 === 1 ? 'designer' : 'pm' },
      summary: `Summary for entity ${i} about ${i % 2 === 0 ? 'platform' : 'product'} work`,
    });
  }

  // Batched to stay under mutate limit of 50 per call
  const BATCH = 50;
  for (let i = 0; i < ops.length; i += BATCH) {
    stateTree.mutate(ops.slice(i, i + BATCH));
  }

  // Run FTS search several times and measure
  const queries = ['engineer', 'platform', 'domain5', 'entity42'];
  const iterations = 100;

  let ftsTotalMs = 0;
  for (const q of queries) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      searchNodes(core, q, 20);
    }
    ftsTotalMs += performance.now() - t0;
  }

  // Count current row
  const count = core.db.prepare('SELECT COUNT(*) as n FROM nodes').get() as { n: number };

  console.log(`${count.n} nodes: ${queries.length * iterations} FTS searches took ${ftsTotalMs.toFixed(1)}ms total, avg ${(ftsTotalMs / (queries.length * iterations)).toFixed(2)}ms/search`);
}

await core.closeAsync();
