import chalk from 'chalk';
import type { Node, Edge, Event } from '../types/index.js';
import type { StatusInfo, EdgeInfo, HistoryEntry } from '../service.js';

// ─── Table ───────────────────────────────────────────────

export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(h.length, maxData);
  });

  const header = headers
    .map((h, i) => chalk.bold(h.padEnd(colWidths[i])))
    .join('  ');

  const separator = colWidths.map(w => '─'.repeat(w)).join('──');

  const body = rows.map(row =>
    row.map((cell, i) => (cell ?? '').padEnd(colWidths[i])).join('  ')
  ).join('\n');

  return `${header}\n${chalk.dim(separator)}\n${body}`;
}

// ─── Status ──────────────────────────────────────────────

export function formatStatus(status: StatusInfo): string {
  const lines = [
    chalk.bold('Engram Status'),
    chalk.dim('─'.repeat(40)),
    `  Nodes (active)   ${chalk.green(String(status.activeNodes))}`,
    `  Nodes (archived) ${chalk.dim(String(status.archivedNodes))}`,
    `  Edges            ${chalk.green(String(status.activeEdges))}`,
    `  Events           ${chalk.blue(String(status.totalEvents))}`,
    chalk.dim('─'.repeat(40)),
    `  Data dir         ${chalk.dim(status.dataDir)}`,
  ];
  return lines.join('\n');
}

// ─── Node Detail ─────────────────────────────────────────

export function formatNodeDetail(
  node: Node,
  outEdges: Edge[],
  inEdges: Edge[],
  resolveNodeName: (id: string) => string,
): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`${node.name}`) + chalk.dim(` [${node.type}]`));
  lines.push(chalk.dim('─'.repeat(50)));

  lines.push(`  ID          ${chalk.dim(node.id)}`);
  lines.push(`  Confidence  ${formatConfidence(node.confidence)}`);
  lines.push(`  Version     ${node.version}`);
  lines.push(`  Updated     ${chalk.dim(node.updated_at)}`);

  if (node.summary) {
    lines.push(`  Summary     ${node.summary}`);
  }

  if (Object.keys(node.properties).length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Properties'));
    for (const [key, value] of Object.entries(node.properties)) {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`    ${chalk.cyan(key)}: ${val}`);
    }
  }

  if (outEdges.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Outgoing'));
    for (const e of outEdges) {
      const target = resolveNodeName(e.target_id);
      lines.push(`    ${chalk.green('→')} ${chalk.yellow(e.predicate)} → ${target}`);
    }
  }

  if (inEdges.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Incoming'));
    for (const e of inEdges) {
      const source = resolveNodeName(e.source_id);
      lines.push(`    ${chalk.blue('←')} ${source} → ${chalk.yellow(e.predicate)}`);
    }
  }

  return lines.join('\n');
}

// ─── Node List (table row) ───────────────────────────────

export function formatNodeRows(nodes: Node[]): string {
  if (nodes.length === 0) return chalk.dim('No nodes found.');

  const headers = ['Name', 'Type', 'Confidence', 'Version', 'Updated'];
  const rows = nodes.map(n => [
    n.name,
    n.type,
    formatConfidenceShort(n.confidence),
    String(n.version),
    n.updated_at.split('T')[0],
  ]);

  return formatTable(headers, rows);
}

// ─── Edge List ───────────────────────────────────────────

export function formatEdgeList(nodeName: string, edges: EdgeInfo[]): string {
  if (edges.length === 0) return chalk.dim(`No edges for ${nodeName}.`);

  const lines: string[] = [
    chalk.bold(`Relationships for ${nodeName}`),
    chalk.dim('─'.repeat(50)),
  ];

  for (const e of edges) {
    if (e.sourceName === nodeName) {
      lines.push(`  ${chalk.green('→')} ${nodeName} ${chalk.yellow(`--[${e.edge.predicate}]-->`)} ${e.targetName}`);
    } else {
      lines.push(`  ${chalk.blue('←')} ${e.sourceName} ${chalk.yellow(`--[${e.edge.predicate}]-->`)} ${nodeName}`);
    }
  }

  return lines.join('\n');
}

// ─── Events ──────────────────────────────────────────────

export function formatEventRows(events: Event[]): string {
  if (events.length === 0) return chalk.dim('No events found.');

  const headers = ['ID', 'Type', 'Source', 'Timestamp', 'Preview'];
  const rows = events.map(e => [
    String(e.id),
    e.type,
    e.source,
    e.timestamp.split('T')[0] + ' ' + e.timestamp.split('T')[1]?.slice(0, 8),
    truncate(JSON.stringify(e.content), 40),
  ]);

  return formatTable(headers, rows);
}

// ─── History ─────────────────────────────────────────────

export function formatHistory(
  nodeName: string,
  currentNode: Node,
  history: HistoryEntry[],
): string {
  const lines: string[] = [
    chalk.bold(`History for ${nodeName}`),
    chalk.dim('─'.repeat(50)),
    `  Current (v${currentNode.version}): ${JSON.stringify(currentNode.properties)}`,
  ];

  if (history.length === 0) {
    lines.push(chalk.dim('  No previous versions.'));
  } else {
    for (const h of history) {
      lines.push(
        `  ${chalk.dim(`v${h.version}`)} ${chalk.dim(h.timestamp.split('T')[0])} ` +
        `${JSON.stringify(h.properties)}`
      );
    }
  }

  return lines.join('\n');
}

// ─── Maintenance ─────────────────────────────────────────

export function formatMaintenanceReport(report: {
  decayed: number;
  archived: number;
  orphansDetected: number;
  activeNodes: number;
  activeEdges: number;
  totalEvents: number;
}, dryRun: boolean): string {
  const prefix = dryRun ? chalk.yellow('[DRY RUN] ') : '';
  const lines = [
    chalk.bold(`${prefix}Maintenance Report`),
    chalk.dim('─'.repeat(40)),
    `  Decayed            ${report.decayed}`,
    `  Archived           ${report.archived}`,
    `  Orphans detected   ${report.orphansDetected}`,
    chalk.dim('─'.repeat(40)),
    `  Active nodes       ${report.activeNodes}`,
    `  Active edges       ${report.activeEdges}`,
    `  Total events       ${report.totalEvents}`,
  ];
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────

function formatConfidence(c: number): string {
  if (c >= 0.9) return chalk.green(c.toFixed(2));
  if (c >= 0.5) return chalk.yellow(c.toFixed(2));
  return chalk.red(c.toFixed(2));
}

function formatConfidenceShort(c: number): string {
  return c === 1.0 ? '1.00' : c.toFixed(2);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
