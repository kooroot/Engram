import chalk from 'chalk';
import type { EngramCore } from '../service.js';
import type { UsageByDay, UsageByNamespace, UsageByTool, UsageTotals } from '../db/usage-log.js';

export type Period = 'day' | 'week' | 'month';
export type Breakdown = 'tool' | 'day' | 'namespace';

export interface UsageOptions {
  period: Period;
  breakdown: Breakdown;
  allNamespaces: boolean;
}

const PERIOD_DAYS: Record<Period, number> = {
  day: 1,
  week: 7,
  month: 30,
};

function nowSinceMs(period: Period): number {
  return Date.now() - PERIOD_DAYS[period] * 86400 * 1000;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return fmtNum(n);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function bar(value: number, max: number, width: number = 24): string {
  if (max <= 0) return '';
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function periodLabel(p: Period): string {
  if (p === 'day') return 'last 24 hours';
  if (p === 'week') return 'last 7 days';
  return 'last 30 days';
}

function printTotals(totals: UsageTotals): void {
  if (totals.calls === 0) {
    console.log(chalk.dim('  No tool calls recorded in this window.'));
    return;
  }
  const avgTokens = Math.round(totals.tokens / Math.max(1, totals.calls));
  const avgMs = Math.round(totals.durationMs / Math.max(1, totals.calls));
  console.log(`  ${chalk.bold(fmtNum(totals.tokens))} tokens  •  ${chalk.bold(fmtNum(totals.calls))} calls`);
  console.log(`  ${chalk.dim(`avg ${fmtNum(avgTokens)} tok/call  •  avg ${avgMs} ms/call  •  total ${fmtDuration(totals.durationMs)}`)}`);
}

function printByTool(rows: UsageByTool[], totalTokens: number): void {
  if (rows.length === 0) {
    console.log(chalk.dim('  (no calls)'));
    return;
  }
  const max = rows[0].tokens;
  const labelWidth = Math.max(...rows.map(r => r.tool.length));
  for (const r of rows) {
    const label = r.tool.padEnd(labelWidth);
    const tokens = fmtTokens(r.tokens).padStart(8);
    const calls = fmtNum(r.calls).padStart(5);
    const percent = pct(r.tokens, totalTokens).padStart(4);
    console.log(`  ${chalk.cyan(label)}  ${tokens}  ${chalk.dim(percent)}  ${chalk.dim(calls + ' calls')}  ${chalk.green(bar(r.tokens, max))}`);
  }
}

function printByDay(rows: UsageByDay[], totalTokens: number): void {
  if (rows.length === 0) {
    console.log(chalk.dim('  (no calls)'));
    return;
  }
  const max = Math.max(...rows.map(r => r.tokens));
  for (const r of rows) {
    const tokens = fmtTokens(r.tokens).padStart(8);
    const calls = fmtNum(r.calls).padStart(5);
    const percent = pct(r.tokens, totalTokens).padStart(4);
    console.log(`  ${chalk.cyan(r.day)}  ${tokens}  ${chalk.dim(percent)}  ${chalk.dim(calls + ' calls')}  ${chalk.green(bar(r.tokens, max))}`);
  }
}

function printByNamespace(rows: UsageByNamespace[], totalTokens: number): void {
  if (rows.length === 0) {
    console.log(chalk.dim('  (no calls)'));
    return;
  }
  const max = rows[0].tokens;
  const labelWidth = Math.max(...rows.map(r => r.namespace.length));
  for (const r of rows) {
    const label = r.namespace.padEnd(labelWidth);
    const tokens = fmtTokens(r.tokens).padStart(8);
    const calls = fmtNum(r.calls).padStart(5);
    const percent = pct(r.tokens, totalTokens).padStart(4);
    console.log(`  ${chalk.cyan(label)}  ${tokens}  ${chalk.dim(percent)}  ${chalk.dim(calls + ' calls')}  ${chalk.green(bar(r.tokens, max))}`);
  }
}

export function runUsage(core: EngramCore, opts: UsageOptions): void {
  const sinceMs = nowSinceMs(opts.period);
  const ns = opts.allNamespaces ? undefined : core.config.namespace;

  const headerNs = opts.allNamespaces ? 'all namespaces' : `namespace=${core.config.namespace}`;
  console.log(chalk.bold(`\nEngram usage — ${periodLabel(opts.period)}  (${headerNs})\n`));

  const totals = core.usageLog.totals(sinceMs, ns);
  printTotals(totals);
  console.log('');

  if (opts.breakdown === 'tool') {
    console.log(chalk.bold('  By tool'));
    console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
    printByTool(core.usageLog.byTool(sinceMs, ns), totals.tokens);
  } else if (opts.breakdown === 'day') {
    console.log(chalk.bold('  By day'));
    console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
    printByDay(core.usageLog.byDay(sinceMs, ns), totals.tokens);
  } else if (opts.breakdown === 'namespace') {
    console.log(chalk.bold('  By namespace'));
    console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
    printByNamespace(core.usageLog.byNamespace(sinceMs), totals.tokens);
  }

  console.log('');
  console.log(chalk.dim(`  Token estimate uses ~3.3 chars/token. Switch breakdown via --by tool|day|namespace.`));
  console.log(chalk.dim(`  All-namespace view: engram usage --all`));
  console.log('');
}
