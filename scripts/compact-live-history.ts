/**
 * One-shot retroactive history compaction for the LIVE engram DB (~/.engram).
 *
 * Runs ONLY runHistoryCompaction (keep-last-N + original v1) — deliberately does
 * NOT run the full maintenance cycle, so confidence-decay / archive / orphan
 * passes are never triggered on live data. Safe under concurrent MCP servers
 * (WAL + busy_timeout); node_history is audit/display-only and never replayed.
 *
 * Usage: bun run scripts/compact-live-history.ts [keepN]   (default keepN=20)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { runHistoryCompaction } from '../src/engine/maintenance.js';

const NS = 'default';
const KEEP_RAW = process.argv[2] ?? '20';
const KEEP = Number(KEEP_RAW);
const DB_PATH = path.join(os.homedir(), '.engram', 'engram.db');

if (!Number.isInteger(KEEP) || KEEP < 0) {
  console.error(`Invalid keepN: ${KEEP_RAW}`);
  console.error('Usage: bun run scripts/compact-live-history.ts [non-negative-integer]');
  process.exit(1);
}

function stats(db: Database.Database) {
  return db
    .prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(properties)),0) AS bytes FROM node_history WHERE namespace = ?')
    .get(NS) as { rows: number; bytes: number };
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000'); // tolerate concurrent MCP-server writers

const before = stats(db);
const top = db
  .prepare('SELECT node_id, COUNT(*) AS versions, SUM(length(properties)) AS bytes FROM node_history WHERE namespace = ? GROUP BY node_id ORDER BY bytes DESC LIMIT 5')
  .all(NS) as Array<{ node_id: string; versions: number; bytes: number }>;

console.log(`keepN=${KEEP}  namespace=${NS}`);
console.log(`BEFORE: ${before.rows} history rows, ${(before.bytes / 1_048_576).toFixed(2)} MB of snapshot bytes`);
console.log('Top history nodes (pre-compaction):');
for (const t of top) {
  console.log(`  ${t.node_id}  ${t.versions} versions  ${(t.bytes / 1_048_576).toFixed(2)} MB`);
}

const dry = runHistoryCompaction(db, NS, KEEP, true);
console.log(`\nDRY-RUN: would prune ${dry.historyPruned} snapshot row(s)`);

const live = runHistoryCompaction(db, NS, KEEP, false);
const after = stats(db);
console.log(`LIVE:    pruned ${live.historyPruned} snapshot row(s)`);
console.log(`AFTER:  ${after.rows} history rows, ${(after.bytes / 1_048_576).toFixed(2)} MB of snapshot bytes`);

try {
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('WAL checkpoint(TRUNCATE): ok');
} catch (e) {
  console.log('WAL checkpoint skipped (busy):', String(e));
}
db.close();
