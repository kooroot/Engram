import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { EngramCore } from '../service.js';
import { listNamespaces } from '../service.js';

export interface ResetOptions {
  /** When true, reset every namespace in the DB instead of just the current one. */
  all?: boolean;
  /** Skip the interactive confirmation prompt. */
  yes?: boolean;
  /** Copy main + vec DB files to .bak-<timestamp> before deleting. */
  backup?: boolean;
}

interface NamespaceCounts {
  nodes: number;
  edges: number;
  events: number;
  node_history: number;
  usage_log: number;
  embeddings: number;
}

const TARGETS_MAIN: ReadonlyArray<keyof NamespaceCounts> = [
  'nodes',
  'edges',
  'events',
  'node_history',
  'usage_log',
];

const TARGETS_VEC: ReadonlyArray<keyof NamespaceCounts> = ['embeddings'];

export async function runReset(core: EngramCore, opts: ResetOptions): Promise<void> {
  const allKnown = listNamespaces(core);
  const targets: string[] = opts.all
    ? (allKnown.length > 0 ? allKnown : [core.config.namespace])
    : [core.config.namespace];

  if (targets.length === 0) {
    console.log(chalk.gray('No namespaces to reset.'));
    return;
  }

  // Preview: how many rows in each namespace before we delete.
  const preview = previewCounts(core, targets);
  printPreview(targets, preview);

  if (!opts.yes) {
    const confirmed = await p.confirm({
      message: `This will permanently delete the rows above. Continue?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      console.log(chalk.gray('Cancelled — no data deleted.'));
      return;
    }
  }

  if (opts.backup) {
    const backups = backupDbFiles(core);
    for (const b of backups) {
      console.log(chalk.dim(`  backup: ${b}`));
    }
  }

  // Delete (per-namespace, in transactions).
  const results: Record<string, NamespaceCounts> = {};
  for (const ns of targets) {
    results[ns] = deleteNamespace(core, ns);
  }

  printResults(results);
}

function previewCounts(core: EngramCore, namespaces: string[]): Record<string, NamespaceCounts> {
  const out: Record<string, NamespaceCounts> = {};
  for (const ns of namespaces) {
    out[ns] = {
      nodes:        countRows(core.mainDb.db, 'nodes', ns),
      edges:        countRows(core.mainDb.db, 'edges', ns),
      events:       countRows(core.mainDb.db, 'events', ns),
      node_history: countRows(core.mainDb.db, 'node_history', ns),
      usage_log:    countRows(core.mainDb.db, 'usage_log', ns),
      embeddings:   countRows(core.vecDb.db, 'embeddings', ns),
    };
  }
  return out;
}

function countRows(db: { prepare: (sql: string) => { get: (arg: string) => unknown } }, table: string, namespace: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE namespace = ?`).get(namespace) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function deleteNamespace(core: EngramCore, ns: string): NamespaceCounts {
  const counts: NamespaceCounts = {
    nodes: 0, edges: 0, events: 0, node_history: 0, usage_log: 0, embeddings: 0,
  };

  // Main DB — single transaction so we don't end up with partial state.
  // Note: edges + node_history have ON DELETE CASCADE → nodes, so we must
  // pre-count BEFORE the delete chain or cascade will zero out the report.
  const mainTx = core.mainDb.db.transaction((namespace: string) => {
    for (const t of TARGETS_MAIN) {
      const before = core.mainDb.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE namespace = ?`).get(namespace) as { n: number };
      counts[t] = before?.n ?? 0;
      core.mainDb.db.prepare(`DELETE FROM ${t} WHERE namespace = ?`).run(namespace);
    }
  });
  mainTx(ns);

  // Vec DB — separate connection, separate transaction.
  try {
    const vecTx = core.vecDb.db.transaction((namespace: string) => {
      for (const t of TARGETS_VEC) {
        const before = core.vecDb.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE namespace = ?`).get(namespace) as { n: number };
        counts[t] = before?.n ?? 0;
        core.vecDb.db.prepare(`DELETE FROM ${t} WHERE namespace = ?`).run(namespace);
      }
    });
    vecTx(ns);
  } catch {
    // vec store optional — swallow if missing
  }

  // Invalidate in-memory caches so the next request sees the empty state.
  core.cache.clear();

  return counts;
}

function backupDbFiles(core: EngramCore): string[] {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dataDir = core.config.dataDir;
  const targets = [
    path.join(dataDir, core.config.dbFilename),
    path.join(dataDir, core.config.vecDbFilename),
  ];
  const created: string[] = [];
  for (const src of targets) {
    if (!fs.existsSync(src)) continue;
    const dest = `${src}.bak-${ts}`;
    fs.copyFileSync(src, dest);
    created.push(dest);
  }
  return created;
}

function printPreview(namespaces: string[], counts: Record<string, NamespaceCounts>): void {
  console.log(chalk.bold(`\nReset preview — ${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}\n`));
  for (const ns of namespaces) {
    const c = counts[ns];
    const total = sumCounts(c);
    if (total === 0) {
      console.log(`  ${chalk.cyan(ns)} ${chalk.dim('(already empty)')}`);
      continue;
    }
    console.log(`  ${chalk.cyan(ns)}  ${chalk.bold(total + ' rows')}`);
    console.log(chalk.dim(
      `    nodes=${c.nodes}  edges=${c.edges}  events=${c.events}  ` +
      `history=${c.node_history}  usage=${c.usage_log}  embeddings=${c.embeddings}`,
    ));
  }
  console.log('');
  console.log(chalk.dim('  Engram config (engram.env), MCP registrations, and AI instruction'));
  console.log(chalk.dim('  files (CLAUDE.md / AGENTS.md / GEMINI.md) are NOT touched.'));
  console.log('');
}

function printResults(results: Record<string, NamespaceCounts>): void {
  let grandTotal = 0;
  console.log('');
  for (const [ns, c] of Object.entries(results)) {
    const total = sumCounts(c);
    grandTotal += total;
    console.log(`  ${chalk.green('✓')} ${chalk.cyan(ns)}  ${total} rows deleted`);
  }
  console.log('');
  console.log(chalk.bold(`  Done — ${grandTotal} rows across ${Object.keys(results).length} namespace${Object.keys(results).length === 1 ? '' : 's'}.`));
  console.log('');
}

function sumCounts(c: NamespaceCounts): number {
  return c.nodes + c.edges + c.events + c.node_history + c.usage_log + c.embeddings;
}
