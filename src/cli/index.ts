import { Command } from 'commander';
import { createEngramCore, type EngramCore } from '../service.js';
import * as svc from '../service.js';
import * as fmt from './formatters.js';
import type { EventType } from '../types/index.js';

/** M2: Safe parseInt with fallback for CLI options */
function safeInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
    .action((topic, opts) => withCore(async (core) => {
      const entities = opts.entities
        ? opts.entities.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      const context = await svc.getContext(core, {
        topic,
        entities,
        maxTokens: safeInt(opts.maxTokens, 2000),
        strategy: opts.strategy as svc.ContextStrategy,
      });
      console.log(context);
    }, ns())());

  // ─── maintenance ─────────────────────────────────

  program
    .command('maintenance')
    .description('Run maintenance cycle (decay, archive, orphan cleanup)')
    .option('-d, --dry-run', 'Preview without making changes')
    .action((opts) => withCore((core) => {
      const report = svc.runMaintenanceCycle(core, opts.dryRun ?? false);
      console.log(fmt.formatMaintenanceReport(report, opts.dryRun ?? false));
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
