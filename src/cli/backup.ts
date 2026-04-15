import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import type { EngramCore } from '../service.js';

export interface BackupMeta {
  ts: string;
  label?: string;
  namespace: string;
  totals: {
    nodes: number;
    edges: number;
    events: number;
    history: number;
    usage: number;
    embeddings: number;
  };
  source: string;
  engramVersion?: string;
}

export interface BackupEntry {
  id: string;
  path: string;
  meta: BackupMeta;
}

export const DEFAULT_KEEP = 5;

function backupRootDir(core: EngramCore): string {
  return path.join(core.config.dataDir, 'backups');
}

function getKeep(opts: { keep?: number }): number {
  if (typeof opts.keep === 'number' && opts.keep > 0) return opts.keep;
  const env = process.env['ENGRAM_BACKUP_KEEP'];
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_KEEP;
}

function countMain(core: EngramCore, table: string): number {
  try {
    const row = core.mainDb.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function countVec(core: EngramCore, table: string): number {
  try {
    const row = core.vecDb.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

export interface CreateBackupOptions {
  label?: string;
  keep?: number;
  silent?: boolean;
}

export function createBackup(core: EngramCore, opts: CreateBackupOptions = {}): BackupEntry {
  const root = backupRootDir(core);
  fs.mkdirSync(root, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dirName = opts.label ? `${ts}_${slug(opts.label)}` : ts;
  const targetDir = path.join(root, dirName);
  fs.mkdirSync(targetDir, { recursive: true });

  const main = path.join(core.config.dataDir, core.config.dbFilename);
  const vec  = path.join(core.config.dataDir, core.config.vecDbFilename);

  // Force a checkpoint so the DB file reflects all WAL changes before copy.
  try { core.mainDb.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  try { core.vecDb.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

  if (fs.existsSync(main)) fs.copyFileSync(main, path.join(targetDir, core.config.dbFilename));
  if (fs.existsSync(vec))  fs.copyFileSync(vec,  path.join(targetDir, core.config.vecDbFilename));

  const meta: BackupMeta = {
    ts: new Date().toISOString(),
    label: opts.label,
    namespace: core.config.namespace,
    totals: {
      nodes:      countMain(core, 'nodes'),
      edges:      countMain(core, 'edges'),
      events:     countMain(core, 'events'),
      history:    countMain(core, 'node_history'),
      usage:      countMain(core, 'usage_log'),
      embeddings: countVec(core, 'embeddings'),
    },
    source: os.hostname(),
  };
  fs.writeFileSync(path.join(targetDir, 'meta.json'), JSON.stringify(meta, null, 2));

  if (!opts.silent) {
    const total = meta.totals.nodes + meta.totals.edges + meta.totals.events + meta.totals.history + meta.totals.usage + meta.totals.embeddings;
    console.log(chalk.green(`✓ Backup created: ${dirName}  (${total} rows)`));
    console.log(chalk.dim(`  ${targetDir}`));
  }

  const keep = getKeep(opts);
  const pruned = pruneOldBackups(core, keep);
  if (pruned > 0 && !opts.silent) {
    console.log(chalk.dim(`  ${pruned} old backup${pruned === 1 ? '' : 's'} pruned (keeping newest ${keep})`));
  }

  return { id: dirName, path: targetDir, meta };
}

export function listBackups(core: EngramCore): BackupEntry[] {
  const root = backupRootDir(core);
  if (!fs.existsSync(root)) return [];

  const entries: BackupEntry[] = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let meta: BackupMeta;
    try {
      const raw = fs.readFileSync(path.join(full, 'meta.json'), 'utf8');
      meta = JSON.parse(raw);
    } catch {
      meta = {
        ts: stat.mtime.toISOString(),
        namespace: 'unknown',
        totals: { nodes: 0, edges: 0, events: 0, history: 0, usage: 0, embeddings: 0 },
        source: 'unknown',
      };
    }
    entries.push({ id: dir, path: full, meta });
  }

  entries.sort((a, b) => b.meta.ts.localeCompare(a.meta.ts));
  return entries;
}

function pruneOldBackups(core: EngramCore, keep: number): number {
  const all = listBackups(core);
  if (all.length <= keep) return 0;
  const toDelete = all.slice(keep);
  for (const entry of toDelete) {
    try { fs.rmSync(entry.path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return toDelete.length;
}

// ─── CLI runners ─────────────────────────────────────────

export interface BackupCliOptions {
  label?: string;
  keep?: number;
}

export function runBackup(core: EngramCore, opts: BackupCliOptions): void {
  createBackup(core, opts);
}

export function runListBackups(core: EngramCore): void {
  const all = listBackups(core);
  const root = backupRootDir(core);
  if (all.length === 0) {
    console.log(chalk.gray(`No backups in ${root}`));
    return;
  }
  console.log(chalk.bold(`\n${all.length} backup${all.length === 1 ? '' : 's'} — newest first  (${root})\n`));
  for (const b of all) {
    const totalRows = b.meta.totals.nodes + b.meta.totals.edges + b.meta.totals.events
      + b.meta.totals.history + b.meta.totals.usage + b.meta.totals.embeddings;
    const labelTag = b.meta.label ? `  ${chalk.cyan('[' + b.meta.label + ']')}` : '';
    console.log(`  ${chalk.cyan(b.id)}${labelTag}`);
    console.log(chalk.dim(
      `    ${b.meta.ts}  •  ${totalRows} rows  •  ` +
      `nodes=${b.meta.totals.nodes} edges=${b.meta.totals.edges} ` +
      `events=${b.meta.totals.events} history=${b.meta.totals.history} ` +
      `usage=${b.meta.totals.usage} embeddings=${b.meta.totals.embeddings}`,
    ));
  }
  console.log('');
  console.log(chalk.dim(`  Default retention: ${getKeep({})} backups (override with --keep N or ENGRAM_BACKUP_KEEP env var)`));
  console.log('');
}
