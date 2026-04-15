import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { EngramCore } from '../service.js';
import { listBackups, createBackup, type BackupEntry } from './backup.js';

export interface RestoreOptions {
  id?: string;
  latest?: boolean;
  yes?: boolean;
  noSafetyBackup?: boolean;
}

export async function runRestore(core: EngramCore, opts: RestoreOptions): Promise<void> {
  const all = listBackups(core);
  if (all.length === 0) {
    console.log(chalk.yellow('No backups found.'));
    console.log(chalk.dim(`  Run \`engram backup\` first to create one.`));
    return;
  }

  let target: BackupEntry | undefined;
  if (opts.latest) {
    target = all[0];
  } else if (opts.id) {
    target = all.find(b => b.id === opts.id || b.meta.label === opts.id);
    if (!target) {
      console.log(chalk.red(`No backup matches: ${opts.id}`));
      console.log(chalk.dim('  Run `engram backups` to list available backups.'));
      return;
    }
  } else {
    const selected = await p.select<string>({
      message: 'Pick a backup to restore:',
      options: all.map(b => {
        const total = b.meta.totals.nodes + b.meta.totals.edges + b.meta.totals.events;
        return {
          value: b.id,
          label: b.meta.label ? `${b.id}  [${b.meta.label}]` : b.id,
          hint: `${b.meta.ts}  ·  ${total} rows`,
        };
      }),
    });
    if (p.isCancel(selected)) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
    target = all.find(b => b.id === selected)!;
  }

  console.log(chalk.bold(`\nRestore: ${target.id}\n`));
  console.log(chalk.dim(`  ts:        ${target.meta.ts}`));
  if (target.meta.label) console.log(chalk.dim(`  label:     ${target.meta.label}`));
  console.log(chalk.dim(`  contents:  nodes=${target.meta.totals.nodes} edges=${target.meta.totals.edges} events=${target.meta.totals.events}`));
  console.log('');
  console.log(chalk.yellow('  ⚠ This will REPLACE the current database with the backup.'));
  if (!opts.noSafetyBackup) {
    console.log(chalk.dim('    A "pre-restore" safety backup of the current state is created first.'));
  } else {
    console.log(chalk.red('    --no-safety-backup: current state will be lost permanently.'));
  }
  console.log('');

  if (!opts.yes) {
    const confirmed = await p.confirm({
      message: 'Replace current data with this backup?',
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  if (!opts.noSafetyBackup) {
    console.log(chalk.dim('  Creating safety backup of current state...'));
    createBackup(core, { label: 'pre-restore', silent: true });
  }

  // Close DB connections so we can overwrite the files cleanly.
  core.close();

  const main = path.join(core.config.dataDir, core.config.dbFilename);
  const vec  = path.join(core.config.dataDir, core.config.vecDbFilename);
  const backupMain = path.join(target.path, core.config.dbFilename);
  const backupVec  = path.join(target.path, core.config.vecDbFilename);

  // Remove WAL/SHM files so the restored DB isn't blended with stale journal.
  for (const ext of ['-wal', '-shm']) {
    for (const f of [main + ext, vec + ext]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  }

  if (fs.existsSync(backupMain)) fs.copyFileSync(backupMain, main);
  if (fs.existsSync(backupVec))  fs.copyFileSync(backupVec, vec);

  console.log(chalk.green(`✓ Restored from ${target.id}`));
  if (!opts.noSafetyBackup) {
    console.log(chalk.dim('  (Previous state saved as a "pre-restore" backup. Restore that one to undo.)'));
  }
}
