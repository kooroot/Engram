/**
 * Engram performance benchmark harness.
 * Usage: npx tsx bench.ts [--scale 1000,5000,20000] [--live /path/to/live-copy-dir]
 *
 * Isolated: every run works on synthetic DBs created under this script's dir
 * (or a *copy* of the live DB). Never touches ~/.engram.
 */
process.env.ENGRAM_NO_ENV_FILE = '1';
delete process.env.OPENAI_API_KEY;
delete process.env.ENGRAM_EMBEDDING_PROVIDER;
process.env.ENGRAM_LOG_LEVEL = 'error';

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ulid } from 'ulid';
import { createEngramCore, getContext, searchNodes, type EngramCore } from '../src/service.js';
import { findDedupClusters } from '../src/engine/dedup-scan.js';
import { traverseGraph } from '../src/engine/graph-traversal.js';
import { runMaintenance } from '../src/engine/maintenance.js';

const outArg = process.argv.find(a => a.startsWith('--out='));
const HERE = outArg ? outArg.split('=')[1] : path.dirname(new URL(import.meta.url).pathname);

// ── timing ──────────────────────────────────────────────────────────
function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, mean, p50: p(0.5), p95: p(0.95), max: s[s.length - 1] };
}
function fmt(ms: number) {
  return ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(3);
}
async function bench(label: string, iters: number, fn: () => unknown | Promise<unknown>, out: Record<string, any>) {
  // warmup
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  const st = stats(samples);
  out[label] = st;
  console.log(
    `  ${label.padEnd(46)} mean=${fmt(st.mean).padStart(8)}ms  p50=${fmt(st.p50).padStart(8)}ms  p95=${fmt(st.p95).padStart(8)}ms  (n=${st.n})`
  );
  return st;
}

// ── synthetic data ──────────────────────────────────────────────────
const TYPES: Array<[string, number]> = [
  ['insight', 0.45], ['decision', 0.27], ['fact', 0.19],
  ['project', 0.02], ['preference', 0.03], ['concept', 0.04],
];
const VOCAB = ('engram memory graph node edge sqlite vector embedding context session hook agent claude codex ' +
  'polymarket clob order gtc limit market ws watchdog heartbeat pnl roi dashboard prototype auth scaffold bug fix ' +
  'design decision insight fact latency benchmark profile optimize dedup merge archive decay confidence namespace ' +
  'rest api rate token bucket metrics prometheus log event checksum chain history version prune compact maintenance').split(' ');

function synthName(rng: () => number, words = 3 + Math.floor(4 * Math.random())): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(VOCAB[Math.floor(rng() * VOCAB.length)]);
  return parts.join(' ') + ' ' + Math.floor(rng() * 100000); // suffix keeps names distinct
}
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickType(rng: () => number): string {
  let r = rng();
  for (const [t, w] of TYPES) { r -= w; if (r <= 0) return t; }
  return 'fact';
}

/** Populate a core's DB with direct SQL (bypasses dedup scan so setup is fast). */
function populate(core: EngramCore, nNodes: number, seed = 42) {
  const rng = mulberry32(seed);
  const db = core.db;
  const ns = core.config.namespace;
  const now = () => new Date(Date.now() - Math.floor(rng() * 180) * 86400_000).toISOString().replace('T', 'T').replace('Z', '');
  const insNode = db.prepare(`INSERT INTO nodes (id,type,name,properties,summary,confidence,created_at,updated_at,version,archived,namespace)
    VALUES (?,?,?,?,?,?,?,?,1,0,?)`);
  const insEdge = db.prepare(`INSERT OR IGNORE INTO edges (id,source_id,predicate,target_id,properties,confidence,created_at,updated_at,version,archived,namespace)
    VALUES (?,?,?,?,'{}',1.0,?,?,1,0,?)`);
  const insEvent = db.prepare(`INSERT INTO events (type,source,content,state_ref,checksum,namespace) VALUES ('mutation','agent',?,?,?,?)`);
  const insHist = db.prepare(`INSERT INTO node_history (node_id,version,properties,changed_by,namespace) VALUES (?,?,?,NULL,?)`);

  const ids: string[] = [];
  const types: string[] = [];
  const txn = db.transaction(() => {
    for (let i = 0; i < nNodes; i++) {
      const id = ulid();
      const type = pickType(rng);
      const name = synthName(rng);
      const props = JSON.stringify({
        cwd: '/Users/kooroot/Desktop/dev/proj' + Math.floor(rng() * 30),
        stack: 'ts sqlite hono', tag: VOCAB[Math.floor(rng() * VOCAB.length)],
        note: 'synthetic benchmark payload with some meaningful length to be realistic '.repeat(1 + Math.floor(rng() * 3)),
      });
      const summary = `Summary of ${name}: ` + Array.from({ length: 20 }, () => VOCAB[Math.floor(rng() * VOCAB.length)]).join(' ');
      const ts = now();
      insNode.run(id, type, name, props, summary, 0.5 + rng() * 0.5, ts, ts, ns);
      ids.push(id); types.push(type);
      // history: 1-3 snapshots for 30% of nodes
      if (rng() < 0.3) {
        const nh = 1 + Math.floor(rng() * 3);
        for (let v = 1; v <= nh; v++) insHist.run(id, v, props, ns);
      }
    }
    // hubs: first 2% of nodes get 20% of edges
    const nEdges = Math.floor(nNodes * 1.2);
    const hubCount = Math.max(3, Math.floor(nNodes * 0.02));
    const preds = ['discovered_in', 'decided_in', 'relates_to', 'implemented_in', 'applies_to', 'documents'];
    for (let i = 0; i < nEdges; i++) {
      const src = ids[Math.floor(rng() * ids.length)];
      const dst = rng() < 0.2 ? ids[Math.floor(rng() * hubCount)] : ids[Math.floor(rng() * ids.length)];
      if (src === dst) continue;
      const ts = now();
      insEdge.run(ulid(), src, preds[Math.floor(rng() * preds.length)], dst, ts, ts, ns);
    }
    // events ~2x nodes
    let prev = '';
    for (let i = 0; i < nNodes * 2; i++) {
      const content = JSON.stringify({ operations: [{ op: 'create', type: 'fact', name: synthName(rng) }] });
      insEvent.run(content, null, 'deadbeef', ns);
    }
  });
  txn();
  db.exec('ANALYZE');
  return { ids, types };
}

// ── benchmark suite ─────────────────────────────────────────────────
async function runSuite(tag: string, core: EngramCore, ids: string[], results: Record<string, any>) {
  console.log(`\n=== ${tag} ===`);
  const out: Record<string, any> = {};
  results[tag] = out;
  const db = core.db;
  const ns = core.config.namespace;
  const activeNodes = (db.prepare('SELECT COUNT(*) c FROM nodes WHERE namespace=? AND archived=0').get(ns) as any).c;
  const edges = (db.prepare('SELECT COUNT(*) c FROM edges WHERE namespace=? AND archived=0').get(ns) as any).c;
  const events = (db.prepare('SELECT COUNT(*) c FROM events WHERE namespace=?').get(ns) as any).c;
  console.log(`  nodes=${activeNodes} edges=${edges} events=${events}`);
  out.__shape = { activeNodes, edges, events };

  let counter = 0;
  // 1. mutate create — fresh unique names (worst-case dedup scan, no match)
  await bench('mutate: create x1 (fresh name)', 30, () => {
    core.stateTree.mutate([{ op: 'create', type: 'insight', name: `zzqx unique ${ulid()} ${counter++}`, properties: { a: 1 }, summary: 'bench' }]);
  }, out);

  await bench('mutate: create x10 batch (fresh names)', 15, () => {
    core.stateTree.mutate(Array.from({ length: 10 }, (_, i) => ({
      op: 'create' as const, type: 'insight', name: `zzqx batch ${ulid()} ${counter++} ${i}`, properties: { a: 1 }, summary: 'bench',
    })));
  }, out);

  // 2. mutate create — dedup hit (same normalized name as an existing node)
  const dupTarget = core.db.prepare("SELECT name FROM nodes WHERE type='insight' AND namespace=? AND archived=0 LIMIT 1").get(ns) as any;
  if (dupTarget) {
    await bench('mutate: create x1 (dedup exact hit)', 30, () => {
      core.stateTree.mutate([{ op: 'create', type: 'insight', name: dupTarget.name, properties: { b: 2 } }]);
    }, out);
  }

  // 3. update
  const someId = ids[Math.floor(ids.length / 2)];
  await bench('mutate: update x1', 30, () => {
    core.stateTree.mutate([{ op: 'update', node_id: someId, set: { counter: counter++ } }]);
  }, out);

  // 4. link create batch
  await bench('link: create x5 batch', 20, () => {
    const ops = Array.from({ length: 5 }, () => ({
      op: 'create' as const,
      source_id: ids[Math.floor(Math.random() * ids.length)],
      predicate: 'bench_rel_' + (counter++),
      target_id: ids[Math.floor(Math.random() * ids.length)],
    })).filter(o => o.source_id !== o.target_id);
    if (ops.length) core.stateTree.link(ops);
  }, out);

  // 5. event append
  await bench('eventLog: append', 50, () => {
    core.eventLog.append({ type: 'observation', source: 'agent', content: { note: 'bench observation ' + counter++ } });
  }, out);

  // 6. FTS search
  await bench('searchNodes (FTS5)', 50, () => {
    searchNodes(core, 'memory graph optimization decision', 20);
  }, out);

  // 7. get_context (graph strategy — no embeddings)
  await bench('getContext: topic (graph)', 30, async () => {
    await getContext(core, { topic: 'engram memory optimization decision latency', strategy: 'graph', maxTokens: 2000 });
  }, out);

  await bench('getContext: entities+topic (graph)', 30, async () => {
    await getContext(core, { topic: 'benchmark profile', entities: [ids[0], ids[1], ids[2]], strategy: 'graph', maxTokens: 2000 });
  }, out);

  // 8. traverse from a hub, depth 2
  const hub = (db.prepare(`SELECT source_id AS id, COUNT(*) c FROM edges WHERE namespace=? GROUP BY source_id ORDER BY c DESC LIMIT 1`).get(ns) as any);
  if (hub) {
    await bench('traverseGraph: hub depth=2 both', 20, () => {
      traverseGraph(core.stateTree, { from: hub.id, direction: 'both', depth: 2 });
    }, out);
  }

  // 9. dedup cluster scan (tier 1) — quadratic today; keep iters low at scale
  const dedupIters = activeNodes > 10000 ? 1 : activeNodes > 3000 ? 2 : 5;
  await bench('findDedupClusters (tier1)', dedupIters, () => {
    findDedupClusters(db, ns);
  }, out);

  // 10. maintenance (decay+archive+orphans)
  await bench('runMaintenance (decay/archive/orphan)', 5, () => {
    runMaintenance(db, ns, { historyKeepVersions: 20 });
  }, out);

  // 11. node history read
  await bench('getNodeHistory-style read', 30, () => {
    db.prepare('SELECT * FROM node_history WHERE node_id = ? ORDER BY version DESC').all(someId);
  }, out);

  return out;
}

// ── cold start ──────────────────────────────────────────────────────
function benchCoreOpen(dataDir: string, results: Record<string, any>, tag: string) {
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const core = createEngramCore({ dataDir }, { disableAutoEmbed: true });
    samples.push(performance.now() - t0);
    core.close();
  }
  const st = stats(samples);
  results[tag]['createEngramCore (open+migrate+prepare)'] = st;
  console.log(`  ${'createEngramCore (open+migrate+prepare)'.padEnd(46)} mean=${fmt(st.mean).padStart(8)}ms  p50=${fmt(st.p50).padStart(8)}ms  p95=${fmt(st.p95).padStart(8)}ms`);
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const scalesArg = process.argv.find(a => a.startsWith('--scale'));
  const scales = scalesArg ? scalesArg.split('=')[1].split(',').map(Number) : [1000, 5000, 20000];
  const liveArg = process.argv.find(a => a.startsWith('--live'));
  const results: Record<string, any> = {};

  for (const n of scales) {
    const dir = path.join(HERE, `db-${n}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const core = createEngramCore({ dataDir: dir }, { disableAutoEmbed: true });
    const t0 = performance.now();
    const { ids } = populate(core, n);
    console.log(`\npopulated ${n} nodes in ${(performance.now() - t0).toFixed(0)}ms`);
    await runSuite(`synthetic-${n}`, core, ids, results);
    benchCoreOpen(dir, results, `synthetic-${n}`);
    core.close();
  }

  if (liveArg) {
    const liveDir = liveArg.split('=')[1];
    const core = createEngramCore({ dataDir: liveDir }, { disableAutoEmbed: true });
    const ids = (core.db.prepare("SELECT id FROM nodes WHERE namespace='default' AND archived=0").all() as any[]).map(r => r.id);
    await runSuite('live-copy', core, ids, results);
    benchCoreOpen(liveDir, results, 'live-copy');
    core.close();
  }

  fs.writeFileSync(path.join(HERE, `results-${process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'baseline'}.json`), JSON.stringify(results, null, 2));
  console.log('\nresults written.');
}

main().catch(err => { console.error(err); process.exit(1); });
