import chalk from 'chalk';
import type { EngramCore } from '../service.js';
import type { UsageByDay, UsageByNamespace, UsageByTool, UsageTotals } from '../db/usage-log.js';

export type Period = 'day' | 'week' | 'month';
export type Breakdown = 'tool' | 'day' | 'namespace';

export interface UsageOptions {
  period: Period;
  breakdown: Breakdown;
  allNamespaces: boolean;
  plain: boolean;
}

const PERIOD_DAYS: Record<Period, number> = {
  day: 1,
  week: 7,
  month: 30,
};

// 12 weeks ≈ 84 days for the activity heatmap.
const HEATMAP_WEEKS = 12;

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
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
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

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayDiff(a: Date, b: Date): number {
  // Whole-day difference, ignoring DST skew
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

// ─── Heatmap ──────────────────────────────────────────────

const HEATMAP_LEVELS = [
  chalk.hex('#3a3a3a')('▢'),   // 0 — empty
  chalk.hex('#5a2e1a')('▣'),   // L1
  chalk.hex('#a04a1f')('▣'),   // L2
  chalk.hex('#cc7a3f')('▣'),   // L3
  chalk.hex('#ff9a5a')('▣'),   // L4
];

function heatmapLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5)  return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

function renderHeatmap(dailyTokens: Map<string, number>, weeks: number = HEATMAP_WEEKS): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Walk back to most recent Saturday so the right column ends today's week.
  // We render: rows = Mon..Sun, cols = weeks (oldest left → newest right).
  const totalDays = weeks * 7;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (totalDays - 1));
  // Snap startDate back to a Monday so columns align cleanly.
  const dow = (startDate.getDay() + 6) % 7; // 0 = Mon
  startDate.setDate(startDate.getDate() - dow);

  const cols = Math.ceil((dayDiff(today, startDate) + 1) / 7);
  // Compute max for level scaling
  let max = 0;
  for (const v of dailyTokens.values()) if (v > max) max = v;

  const rows: string[] = [];
  // Month label row
  const monthRow: string[] = ['     '];
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const colStart = new Date(startDate);
    colStart.setDate(startDate.getDate() + c * 7);
    if (colStart.getMonth() !== lastMonth) {
      monthRow.push(colStart.toLocaleString('en-US', { month: 'short' }).padEnd(2));
      lastMonth = colStart.getMonth();
    } else {
      monthRow.push('  ');
    }
  }
  rows.push(monthRow.join(''));

  // 7 day rows (Mon..Sun)
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let r = 0; r < 7; r++) {
    const showLabel = r === 0 || r === 2 || r === 4; // Mon, Wed, Fri
    const cells: string[] = [(showLabel ? dayLabels[r] : '   ').padEnd(5)];
    for (let c = 0; c < cols; c++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + c * 7 + r);
      if (date > today) {
        cells.push('  ');
        continue;
      }
      const value = dailyTokens.get(ymd(date)) ?? 0;
      const lvl = heatmapLevel(value, max);
      cells.push(HEATMAP_LEVELS[lvl] + ' ');
    }
    rows.push(cells.join(''));
  }

  // Legend
  rows.push('');
  rows.push(`     ${chalk.dim('Less')} ${HEATMAP_LEVELS[1]} ${HEATMAP_LEVELS[2]} ${HEATMAP_LEVELS[3]} ${HEATMAP_LEVELS[4]} ${chalk.dim('More')}`);

  return rows;
}

// ─── Sessions, streaks ─────────────────────────────────────

interface Session {
  startTs: number;
  endTs: number;
  calls: number;
  tokens: number;
}

const SESSION_GAP_MS = 60 * 60 * 1000; // 60 min

function detectSessions(records: Array<{ ts: number; estTokens: number }>): Session[] {
  const sessions: Session[] = [];
  let cur: Session | null = null;
  for (const r of records) {
    if (!cur || r.ts - cur.endTs > SESSION_GAP_MS) {
      if (cur) sessions.push(cur);
      cur = { startTs: r.ts, endTs: r.ts, calls: 1, tokens: r.estTokens };
    } else {
      cur.endTs = r.ts;
      cur.calls += 1;
      cur.tokens += r.estTokens;
    }
  }
  if (cur) sessions.push(cur);
  return sessions;
}

function streaks(activeDays: Set<string>): { longest: number; current: number } {
  if (activeDays.size === 0) return { longest: 0, current: 0 };
  // Sort dates ascending
  const sorted = Array.from(activeDays).sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseYmd(sorted[i - 1]);
    const cur = parseYmd(sorted[i]);
    if (dayDiff(cur, prev) === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Current streak: consecutive days ending today (or yesterday if today inactive)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let current = 0;
  let cursor = new Date(today);
  while (activeDays.has(ymd(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { longest, current };
}

function favoriteTool(rows: UsageByTool[]): UsageByTool | null {
  return rows.length > 0 ? rows[0] : null;
}

function mostActiveDay(rows: UsageByDay[]): UsageByDay | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, cur) => (cur.tokens > best.tokens ? cur : best));
}

// ─── Renderers ─────────────────────────────────────────────

function printHeader(opts: UsageOptions, namespace: string): void {
  const headerNs = opts.allNamespaces ? 'all namespaces' : `namespace=${namespace}`;
  console.log(chalk.bold(`\nEngram Usage — ${periodLabel(opts.period)}  (${headerNs})\n`));
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

function pad(label: string, width: number): string {
  if (label.length >= width) return label;
  return label + ' '.repeat(width - label.length);
}

function printStatsGrid(args: {
  totalTokens: number;
  activeDays: number;
  windowDays: number;
  longestStreak: number;
  currentStreak: number;
  longestSessionMs: number;
  sessionCount: number;
  mostActiveDay: UsageByDay | null;
  favoriteTool: UsageByTool | null;
}): void {
  const left = [
    `${chalk.dim('Total tokens:')} ${chalk.bold(fmtNum(args.totalTokens))}`,
    `${chalk.dim('Sessions:')} ${chalk.bold(args.sessionCount)}`,
    `${chalk.dim('Active days:')} ${chalk.bold(args.activeDays + '/' + args.windowDays)}`,
    `${chalk.dim('Most active day:')} ${chalk.bold(args.mostActiveDay ? args.mostActiveDay.day : '—')}`,
  ];
  const right = [
    `${chalk.dim('Favorite tool:')} ${chalk.bold(args.favoriteTool ? args.favoriteTool.tool : '—')}`,
    `${chalk.dim('Longest session:')} ${chalk.bold(args.longestSessionMs > 0 ? fmtDuration(args.longestSessionMs) : '—')}`,
    `${chalk.dim('Longest streak:')} ${chalk.bold(args.longestStreak + ' days')}`,
    `${chalk.dim('Current streak:')} ${chalk.bold(args.currentStreak + ' days')}`,
  ];

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    // Approximate column alignment by visible width (best-effort — chalk hides ANSI).
    const visibleLen = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '').length;
    console.log(`  ${l}${' '.repeat(Math.max(2, 38 - visibleLen(l)))}${r}`);
  }
  // Suppress unused
  void pad;
}

// ─── Entry point ───────────────────────────────────────────

export function runUsage(core: EngramCore, opts: UsageOptions): void {
  const sinceMs = nowSinceMs(opts.period);
  const ns = opts.allNamespaces ? undefined : core.config.namespace;

  printHeader(opts, core.config.namespace);

  const totals = core.usageLog.totals(sinceMs, ns);
  printTotals(totals);

  if (opts.plain) {
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
    console.log(chalk.dim('  Token estimate uses ~3.3 chars/token. Add --plain to keep this static layout.'));
    console.log('');
    return;
  }

  // ─── Visual mode (default) ───────────────────────────────
  const heatmapSinceMs = Date.now() - HEATMAP_WEEKS * 7 * 86400 * 1000;
  const heatmapDays = core.usageLog.byDay(heatmapSinceMs, ns);
  const heatmapMap = new Map<string, number>();
  for (const d of heatmapDays) heatmapMap.set(d.day, d.tokens);

  console.log('');
  console.log(chalk.bold(`  Activity (last ${HEATMAP_WEEKS} weeks)`));
  console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
  for (const line of renderHeatmap(heatmapMap)) {
    console.log('  ' + line);
  }

  // Stats over the SAME period as the header (not the heatmap window),
  // so users can compare stats by switching --period without losing the heatmap.
  const periodRecords = core.usageLog.rangeRecords(sinceMs, ns);
  const periodActiveDaysSet = new Set<string>();
  for (const r of periodRecords) periodActiveDaysSet.add(ymd(new Date(r.ts)));
  const sessions = detectSessions(periodRecords);
  const longestSessionMs = sessions.reduce((m, s) => Math.max(m, s.endTs - s.startTs), 0);
  const allActiveDays = new Set<string>();
  for (const r of core.usageLog.rangeRecords(0, ns)) allActiveDays.add(ymd(new Date(r.ts)));
  const streakInfo = streaks(allActiveDays);
  const byToolPeriod = core.usageLog.byTool(sinceMs, ns);
  const byDayPeriod = core.usageLog.byDay(sinceMs, ns);

  console.log('');
  console.log(chalk.bold('  Stats'));
  console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
  printStatsGrid({
    totalTokens: totals.tokens,
    activeDays: periodActiveDaysSet.size,
    windowDays: PERIOD_DAYS[opts.period],
    longestStreak: streakInfo.longest,
    currentStreak: streakInfo.current,
    longestSessionMs,
    sessionCount: sessions.length,
    mostActiveDay: mostActiveDay(byDayPeriod),
    favoriteTool: favoriteTool(byToolPeriod),
  });

  console.log('');
  console.log(chalk.bold(`  By ${opts.breakdown}`));
  console.log(chalk.dim('  ──────────────────────────────────────────────────────'));
  if (opts.breakdown === 'tool') {
    printByTool(byToolPeriod, totals.tokens);
  } else if (opts.breakdown === 'day') {
    printByDay(byDayPeriod, totals.tokens);
  } else {
    printByNamespace(core.usageLog.byNamespace(sinceMs), totals.tokens);
  }

  console.log('');
  console.log(chalk.dim('  Switch view: --period day|week|month  --by tool|day|namespace  --plain  --all'));
  console.log('');
}
