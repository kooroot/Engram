import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { createEngramCore, type EngramCore } from '../service.js';
import * as svc from '../service.js';
import * as fmt from './formatters.js';
import type { EventType } from '../types/index.js';
import { runOnboard } from './onboard.js';
import { runDoctor } from './doctor.js';
import { runUsage, type Period, type Breakdown } from './usage.js';
import { runTui } from './tui.js';
import { runReset } from './reset.js';
import { runBackup, runListBackups } from './backup.js';
import { runRestore } from './restore.js';

// Hook event names accepted by `engram context --hook-format`. Limited to
// what Claude Code's hook contract actually consumes; reject typos at the CLI
// boundary so we don't silently emit unparseable JSON to the hook host.
const HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

/** M2: Safe parseInt with fallback for CLI options */
function safeInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Check if a CLI binary is available on PATH. Used by autosave auto-detect. */
function hasCli(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function withCore(
  fn: (core: EngramCore) => void | Promise<void>,
  namespace?: string,
) {
  return async () => {
    const core = createEngramCore(namespace ? { namespace } : {});
    try {
      await fn(core);
    } finally {
      await core.closeAsync();
    }
  };
}

export function registerCLICommands(program: Command): void {
  // Global --namespace flag overrides ENGRAM_NAMESPACE env var
  program.option('-n, --namespace <name>', 'Namespace to operate on (default: from ENGRAM_NAMESPACE or "default")');

  const ns = () => (program.opts() as { namespace?: string }).namespace;

  // ─── onboard ─────────────────────────────────────

  program
    .command('onboard')
    .description('Interactive setup wizard (data dir, namespace, embedding, Claude Code MCP)')
    .action(async () => {
      await runOnboard();
    });

  // ─── backup / backups / restore ─────────────────

  program
    .command('backup')
    .description('Create a snapshot of the engram DB (auto-prunes oldest beyond --keep)')
    .option('-l, --label <label>', 'Human-readable label appended to the backup folder name')
    .option('-k, --keep <n>', 'Keep newest N backups (default 5; or set ENGRAM_BACKUP_KEEP env var)')
    .action((opts: { label?: string; keep?: string }) => withCore((core) => {
      const keep = opts.keep ? Number(opts.keep) : undefined;
      runBackup(core, { label: opts.label, keep });
    }, ns())());

  program
    .command('backups')
    .description('List all backups for the current data directory')
    .action(() => withCore((core) => runListBackups(core), ns())());

  program
    .command('restore [id]')
    .description('Restore a backup (interactive picker if no id given). Creates a safety backup of current state by default.')
    .option('--latest', 'Restore the most recent backup (no picker)', false)
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--no-safety-backup', "Don't create a safety backup of current state before restoring (DANGEROUS)")
    .action((id: string | undefined, opts: { latest?: boolean; yes?: boolean; safetyBackup?: boolean }) => withCore(async (core) => {
      // commander turns --no-safety-backup into safetyBackup=false (default true)
      const noSafety = opts.safetyBackup === false;
      await runRestore(core, { id, latest: opts.latest, yes: opts.yes, noSafetyBackup: noSafety });
    }, ns())());

  // ─── reset ───────────────────────────────────────

  program
    .command('reset')
    .description('Delete all data for a namespace (asks whether to backup first; safe by default)')
    .option('-a, --all', 'Reset every namespace in the DB, not just the current one', false)
    .option('-y, --yes', 'Skip confirm prompt. Defaults to backup ON unless --no-backup is also passed.', false)
    .option('--no-backup', "Don't create a backup before deleting (skips the backup question)")
    .action((opts: { all?: boolean; yes?: boolean; backup?: boolean }) => withCore(async (core) => {
      // commander: declaring `--no-backup` makes opts.backup default to true
      // and become false only when --no-backup is explicitly passed.
      const noBackup = opts.backup === false;
      await runReset(core, {
        all: opts.all,
        yes: opts.yes,
        backup: false,   // never auto-on; the runReset logic handles --yes default
        noBackup,
      });
    }, ns())());

  // ─── doctor ──────────────────────────────────────

  program
    .command('doctor')
    .description('Diagnose Engram installation (build, data dir, embeddings, MCP registration)')
    .option('--fix', 'Attempt to auto-repair detected issues (e.g. rebuild native modules)')
    .option('--quiet', 'Suppress the banner')
    .action(async (opts: { fix?: boolean; quiet?: boolean }) => {
      await runDoctor({ fix: opts.fix, quiet: opts.quiet });
    });

  // ─── usage ───────────────────────────────────────
  // Default: interactive multi-tab TUI (Stats / Usage / Browse / Status).
  // --plain or non-TTY: static text output (CI-friendly).

  program
    .command('usage')
    .description('Interactive dashboard — heatmap, stats, browse, status. Pass --plain for static output.')
    .option('-p, --period <period>', '(--plain only) Time window: day | week | month', 'week')
    .option('-b, --by <breakdown>', '(--plain only) Breakdown: tool | day | namespace', 'tool')
    .option('-a, --all', '(--plain only) Include all namespaces', false)
    .option('--plain', 'Static text layout — totals + breakdown only (CI-friendly)', false)
    .action((opts: { period: string; by: string; all?: boolean; plain?: boolean }) => withCore(async (core) => {
      const useTui = !opts.plain && process.stdout.isTTY;
      if (useTui) {
        await runTui(core);
        return;
      }
      const period = (['day', 'week', 'month'].includes(opts.period) ? opts.period : 'week') as Period;
      const breakdown = (['tool', 'day', 'namespace'].includes(opts.by) ? opts.by : 'tool') as Breakdown;
      runUsage(core, { period, breakdown, allNamespaces: !!opts.all, plain: true });
    }, ns())());

  // Keep `engram tui` as a hidden alias so existing muscle memory still works.
  program
    .command('tui', { hidden: true })
    .description('Alias for `engram usage` (interactive dashboard)')
    .action(() => withCore(async (core) => {
      await runTui(core);
    }, ns())());

  // ─── status ──────────────────────────────────────

  program
    .command('status')
    .description('Show memory graph statistics for the current namespace')
    .action(() => withCore((core) => {
      const status = svc.getStatus(core);
      console.log(fmt.formatStatus(status));
    }, ns())());

  // ─── namespaces ──────────────────────────────────

  program
    .command('namespaces')
    .description('List all namespaces in the database')
    .action(() => withCore((core) => {
      const list = svc.listNamespaces(core);
      if (list.length === 0) {
        console.log('(no namespaces yet)');
        return;
      }
      for (const name of list) {
        const current = name === core.config.namespace ? ' (current)' : '';
        console.log(`  ${name}${current}`);
      }
    }, ns())());

  // ─── nodes ───────────────────────────────────────

  program
    .command('nodes')
    .description('List nodes in the knowledge graph')
    .option('-t, --type <type>', 'Filter by node type')
    .option('-l, --limit <n>', 'Max results', '50')
    .action((opts) => withCore((core) => {
      const nodes = svc.listNodes(core, {
        type: opts.type,
        limit: safeInt(opts.limit, 50),
      });
      console.log(fmt.formatNodeRows(nodes));
    }, ns())());

  // ─── node ────────────────────────────────────────

  program
    .command('node <name-or-id>')
    .description('Show detailed info about a node')
    .action((nameOrId) => withCore((core) => {
      const detail = svc.getNodeDetail(core, nameOrId);
      if (!detail) {
        console.error(`Node not found: ${nameOrId}`);
        process.exitCode = 1;
        return;
      }
      const resolveName = (id: string) =>
        core.stateTree.getNode(id)?.name ?? id;
      console.log(fmt.formatNodeDetail(
        detail.node, detail.outEdges, detail.inEdges, resolveName,
      ));
    }, ns())());

  // ─── edges ───────────────────────────────────────

  program
    .command('edges <name-or-id>')
    .description('Show relationships for a node')
    .action((nameOrId) => withCore((core) => {
      const result = svc.getEdgesForNode(core, nameOrId);
      if (!result) {
        console.error(`Node not found: ${nameOrId}`);
        process.exitCode = 1;
        return;
      }
      console.log(fmt.formatEdgeList(result.node.name, result.edges));
    }, ns())());

  // ─── search ──────────────────────────────────────

  program
    .command('search <query>')
    .description('Search nodes by keyword')
    .option('-l, --limit <n>', 'Max results', '20')
    .action((query, opts) => withCore((core) => {
      const results = svc.searchNodes(core, query, safeInt(opts.limit, 20));
      console.log(fmt.formatNodeRows(results));
    }, ns())());

  // ─── events ──────────────────────────────────────

  program
    .command('events')
    .description('Show recent events from the log')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('-t, --type <type>', 'Filter by event type')
    .action((opts) => withCore((core) => {
      const events = svc.listEvents(core, {
        limit: safeInt(opts.limit, 20),
        type: opts.type as EventType | undefined,
      });
      console.log(fmt.formatEventRows(events));
    }, ns())());

  // ─── history ─────────────────────────────────────

  program
    .command('history <name-or-id>')
    .description('Show version history of a node')
    .action((nameOrId) => withCore((core) => {
      const result = svc.getNodeHistory(core, nameOrId);
      if (!result) {
        console.error(`Node not found: ${nameOrId}`);
        process.exitCode = 1;
        return;
      }
      console.log(fmt.formatHistory(result.node.name, result.node, result.history));
    }, ns())());

  // ─── context ─────────────────────────────────────

  program
    .command('context <topic>')
    .description('Get context for a topic (same as get_context tool)')
    .option('-e, --entities <items>', 'Comma-separated entity names', '')
    .option('-m, --max-tokens <n>', 'Token budget', '2000')
    .option('-s, --strategy <strategy>', 'graph | semantic | hybrid', 'hybrid')
    .option('--hook-format <event>', 'Wrap output as Claude Code hook JSON (event: SessionStart|UserPromptSubmit)')
    .action((topic: string, opts: {
      entities: string;
      maxTokens: string;
      strategy: string;
      hookFormat?: string;
    }) => withCore(async (core) => {
      if (opts.hookFormat && !HOOK_EVENTS.has(opts.hookFormat)) {
        process.stderr.write(
          `Invalid --hook-format: ${opts.hookFormat}. ` +
          `Expected one of: ${[...HOOK_EVENTS].join(', ')}\n`,
        );
        process.exit(1);
      }
      const entities = opts.entities
        ? opts.entities.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      const context = await svc.getContext(core, {
        topic,
        entities,
        maxTokens: safeInt(opts.maxTokens, 2000),
        strategy: opts.strategy as svc.ContextStrategy,
      });
      if (opts.hookFormat) {
        // Use exact-match against the service sentinel rather than substring,
        // so a legitimate context that happens to mention "No relevant context"
        // is not silently dropped.
        if (!context || context.trim() === 'No relevant context found.') {
          process.exit(0); // hook injects nothing
        }
        const out = {
          hookSpecificOutput: {
            hookEventName: opts.hookFormat,
            additionalContext: `[Engram Memory] Relevant context for "${topic}":\n\n${context}`,
          },
        };
        console.log(JSON.stringify(out));
      } else {
        console.log(context);
      }
    }, ns())());

  // ─── autosave (twin mode) ───────────────────────
  program
    .command('autosave <transcript>')
    .description('Extract substance from a session transcript and save to memory (twin mode)')
    .option('-p, --provider <name>', 'LLM provider: auto | claude-cli | codex-cli | gemini-cli | anthropic', 'auto')
    .option('-m, --model <name>', 'Override default model')
    .option('--min-bytes <n>', 'Skip if transcript smaller than this', '200')
    .option('--max-bytes <n>', 'Skip if transcript larger than this (cost guard)', '200000')
    .action((transcript: string, opts: {
      provider: string; model?: string; minBytes: string; maxBytes: string;
    }) => withCore(async (core) => {
      let resolvedProvider: 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'anthropic';
      if (opts.provider === 'auto') {
        // Priority: ENGRAM_HOST_AI hint (set by adapter scripts) →
        // first available CLI (claude > codex > gemini) → SDK fallback.
        const hostHint = process.env['ENGRAM_HOST_AI'];
        if (hostHint === 'claude' && hasCli('claude')) {
          resolvedProvider = 'claude-cli';
        } else if (hostHint === 'codex' && hasCli('codex')) {
          resolvedProvider = 'codex-cli';
        } else if (hostHint === 'gemini' && hasCli('gemini')) {
          resolvedProvider = 'gemini-cli';
        } else if (hasCli('claude')) {
          resolvedProvider = 'claude-cli';
        } else if (hasCli('codex')) {
          resolvedProvider = 'codex-cli';
        } else if (hasCli('gemini')) {
          resolvedProvider = 'gemini-cli';
        } else if (process.env['ANTHROPIC_API_KEY']) {
          resolvedProvider = 'anthropic';
        } else {
          process.stderr.write(
            '[engram] no provider available: install claude/codex/gemini CLI ' +
            'or set ANTHROPIC_API_KEY\n',
          );
          process.exit(1);
        }
      } else if (
        opts.provider === 'claude-cli'
        || opts.provider === 'codex-cli'
        || opts.provider === 'gemini-cli'
        || opts.provider === 'anthropic'
      ) {
        resolvedProvider = opts.provider;
      } else {
        process.stderr.write(`[engram] unknown provider: ${opts.provider}\n`);
        process.exit(1);
      }

      const { runAutosave } = await import('../twin/autosave.js');
      const { ExtractionParseError } = await import('../twin/providers.js');
      try {
        const report = await runAutosave({
          core,
          transcriptPath: transcript,
          provider: resolvedProvider,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          minTranscriptBytes: safeInt(opts.minBytes, 200),
          maxTranscriptBytes: safeInt(opts.maxBytes, 200_000),
        });

        // Summary to stderr — keeps stdout clean for hook composition
        const skipNote = report.skipReason ? ` (${report.skipReason})` : '';
        const summary =
          `[engram] autosave: ${report.created} created, ${report.updated} updated, ` +
          `${report.skipped} skipped${skipNote}, ${report.linksCreated} links` +
          (report.duplicatesInBatch ? `, ${report.duplicatesInBatch} dup-in-batch` : '') +
          (report.errors.length ? `, ${report.errors.length} errors` : '');
        process.stderr.write(summary + '\n');
        if (report.errors.length) {
          for (const e of report.errors) process.stderr.write(`  error: ${e}\n`);
          // Per Codex Task 3 review note: partial-save runs must surface non-zero
          // exit so adapter hooks can distinguish full vs degraded saves.
          process.exit(2);
        }
      } catch (err) {
        process.stderr.write(`[engram] autosave failed: ${(err as Error).message}\n`);
        // ExtractionParseError carries the raw LLM text — preserve it so the
        // operator can debug what the model actually emitted.
        if (err instanceof ExtractionParseError) {
          const snippet = err.rawText.slice(0, 500);
          process.stderr.write(`  raw response: ${snippet}\n`);
        }
        process.exit(1);
      }
    }, ns())());

  // ─── maintenance ─────────────────────────────────

  program
    .command('maintenance')
    .description('Run maintenance cycle (decay, archive, orphan cleanup)')
    .option('-d, --dry-run', 'Preview without making changes')
    .option('--dedup', 'Also run retroactive dedup (Tier 1: normalized-name / token-subset / Jaccard ≥ 0.7)')
    .option('--semantic', 'When paired with --dedup, also run Tier 2 cosine-similarity matching using stored embeddings (requires an embedding provider)')
    .action((opts) => withCore((core) => {
      const report = svc.runMaintenanceCycle(core, opts.dryRun ?? false, {
        dedup: opts.dedup,
        semantic: opts.semantic,
      });
      console.log(fmt.formatMaintenanceReport(report, opts.dryRun ?? false));
    }, ns())());

  // ─── merge ───────────────────────────────────────

  program
    .command('merge <source> <target>')
    .description('Merge source node into target (re-points edges, archives source)')
    .action((source, target) => withCore((core) => {
      try {
        const result = svc.mergeNodes(core, source, target);
        console.log(`Merged ${source} → ${target}`);
        console.log(`  edges re-pointed: ${result.merged_edges}`);
        console.log(`  edges deduplicated: ${result.dedup_edges}`);
      } catch (err) {
        console.error('Merge failed:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }, ns())());

  // ─── export ──────────────────────────────────────

  program
    .command('export')
    .description('Export the current namespace as JSON (writes to stdout)')
    .option('--no-archived', 'Exclude archived nodes')
    .option('--no-events', 'Exclude event log')
    .option('--no-history', 'Exclude node history')
    .action((opts) => withCore((core) => {
      const bundle = svc.exportNamespace(core, {
        includeArchived: opts.archived,
        includeEvents: opts.events,
        includeHistory: opts.history,
      });
      console.log(JSON.stringify(bundle, null, 2));
    }, ns())());

  // ─── import ──────────────────────────────────────

  program
    .command('import <file>')
    .description('Import a JSON bundle into a namespace')
    .option('--target <ns>', 'Override target namespace (default: bundle.namespace)')
    .option('--strategy <s>', 'Conflict strategy: skip|overwrite|merge|reassign', 'skip')
    .action(async (file, opts) => {
      const fs = await import('node:fs');
      const raw = fs.readFileSync(file, 'utf-8');
      const bundle = JSON.parse(raw);
      const targetNs = opts.target ?? bundle.namespace;
      await withCore((core) => {
        const result = svc.importBundle(core, bundle, {
          targetNamespace: opts.target,
          conflictStrategy: opts.strategy,
        });
        console.log(JSON.stringify(result, null, 2));
      }, targetNs)();
    });

  // ─── serve ───────────────────────────────────────

  program
    .command('serve')
    .description('Start REST API server')
    .option('-p, --port <port>', 'Port number', '3333')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .action(async (opts) => {
      const { serve } = await import('@hono/node-server');
      const { createApp } = await import('../api/index.js');
      const core = createEngramCore(ns() ? { namespace: ns()! } : {});
      const app = createApp(core);
      const port = parseInt(opts.port);

      const server = serve({ fetch: app.fetch, port, hostname: opts.host }, () => {
        console.log(`Engram REST API listening on http://${opts.host}:${port}`);
        console.log(`  namespace (default): ${core.config.namespace}`);
        console.log(`  GET  /api/status`);
        console.log(`  GET  /api/namespaces`);
        console.log(`  GET  /api/nodes`);
        console.log(`  GET  /api/nodes/:id`);
        console.log(`  GET  /api/edges/:nodeId`);
        console.log(`  GET  /api/search?q=...`);
        console.log(`  GET  /api/events`);
        console.log(`  POST /api/context`);
        console.log(`  GET  /api/history/:nodeId`);
        console.log(`  (all endpoints accept ?namespace=xyz or X-Engram-Namespace header)`);
      });

      const shutdown = async () => {
        server.close();
        await core.closeAsync();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
