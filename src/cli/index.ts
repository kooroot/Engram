import { Command } from 'commander';
import { createEngramCore, type EngramCore } from '../service.js';
import * as svc from '../service.js';
import * as fmt from './formatters.js';
import type { EventType } from '../types/index.js';

function withCore(fn: (core: EngramCore) => void | Promise<void>) {
  return async () => {
    const core = createEngramCore();
    try {
      await fn(core);
    } finally {
      core.close();
    }
  };
}

export function registerCLICommands(program: Command): void {
  // ─── status ──────────────────────────────────────

  program
    .command('status')
    .description('Show memory graph statistics')
    .action(withCore((core) => {
      const status = svc.getStatus(core);
      console.log(fmt.formatStatus(status));
    }));

  // ─── nodes ───────────────────────────────────────

  program
    .command('nodes')
    .description('List nodes in the knowledge graph')
    .option('-t, --type <type>', 'Filter by node type')
    .option('-l, --limit <n>', 'Max results', '50')
    .action((opts) => withCore((core) => {
      const nodes = svc.listNodes(core, {
        type: opts.type,
        limit: parseInt(opts.limit),
      });
      console.log(fmt.formatNodeRows(nodes));
    })());

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
    })());

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
    })());

  // ─── search ──────────────────────────────────────

  program
    .command('search <query>')
    .description('Search nodes by keyword')
    .option('-l, --limit <n>', 'Max results', '20')
    .action((query, opts) => withCore((core) => {
      const results = svc.searchNodes(core, query, parseInt(opts.limit));
      console.log(fmt.formatNodeRows(results));
    })());

  // ─── events ──────────────────────────────────────

  program
    .command('events')
    .description('Show recent events from the log')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('-t, --type <type>', 'Filter by event type')
    .action((opts) => withCore((core) => {
      const events = svc.listEvents(core, {
        limit: parseInt(opts.limit),
        type: opts.type as EventType | undefined,
      });
      console.log(fmt.formatEventRows(events));
    })());

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
    })());

  // ─── context ─────────────────────────────────────

  program
    .command('context <topic>')
    .description('Get context for a topic (same as get_context tool)')
    .option('-e, --entities <items>', 'Comma-separated entity names', '')
    .option('-m, --max-tokens <n>', 'Token budget', '2000')
    .action((topic, opts) => withCore((core) => {
      const entities = opts.entities
        ? opts.entities.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      const context = svc.getContext(core, {
        topic,
        entities,
        maxTokens: parseInt(opts.maxTokens),
      });
      console.log(context);
    })());

  // ─── maintenance ─────────────────────────────────

  program
    .command('maintenance')
    .description('Run maintenance cycle (decay, archive, orphan cleanup)')
    .option('-d, --dry-run', 'Preview without making changes')
    .action((opts) => withCore((core) => {
      const report = svc.runMaintenanceCycle(core, opts.dryRun ?? false);
      console.log(fmt.formatMaintenanceReport(report, opts.dryRun ?? false));
    })());
}
