import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { EngramCore } from '../service.js';
import { PERIODS, type Period } from './index.js';

const HEATMAP_WEEKS = 14;

const HEATMAP_COLORS = [
  '#3a3a3a',
  '#5a2e1a',
  '#a04a1f',
  '#cc7a3f',
  '#ff9a5a',
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
function fmtNum(n: number): string { return n.toLocaleString('en-US'); }
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
function heatmapLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const r = value / max;
  if (r < 0.25) return 1;
  if (r < 0.5)  return 2;
  if (r < 0.75) return 3;
  return 4;
}

interface Session { startTs: number; endTs: number; calls: number; }
const SESSION_GAP_MS = 60 * 60 * 1000;

function detectSessions(records: Array<{ ts: number }>): Session[] {
  const out: Session[] = [];
  let cur: Session | null = null;
  for (const r of records) {
    if (!cur || r.ts - cur.endTs > SESSION_GAP_MS) {
      if (cur) out.push(cur);
      cur = { startTs: r.ts, endTs: r.ts, calls: 1 };
    } else {
      cur.endTs = r.ts;
      cur.calls += 1;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function streaks(activeDays: Set<string>): { longest: number; current: number } {
  if (activeDays.size === 0) return { longest: 0, current: 0 };
  const sorted = Array.from(activeDays).sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (dayDiff(parseYmd(sorted[i]), parseYmd(sorted[i - 1])) === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let current = 0;
  const cursor = new Date(today);
  while (activeDays.has(ymd(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { longest, current };
}

function Heatmap({ byDay }: { byDay: Map<string, number> }): React.ReactElement {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalDays = HEATMAP_WEEKS * 7;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (totalDays - 1));
  const dow = (startDate.getDay() + 6) % 7;
  startDate.setDate(startDate.getDate() - dow);
  const cols = Math.ceil((dayDiff(today, startDate) + 1) / 7);

  let max = 0;
  for (const v of byDay.values()) if (v > max) max = v;

  const monthLabels: string[] = [];
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const colStart = new Date(startDate);
    colStart.setDate(startDate.getDate() + c * 7);
    if (colStart.getMonth() !== lastMonth) {
      monthLabels.push(colStart.toLocaleString('en-US', { month: 'short' }).padEnd(2));
      lastMonth = colStart.getMonth();
    } else {
      monthLabels.push('  ');
    }
  }

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const rows: React.ReactElement[] = [];
  for (let r = 0; r < 7; r++) {
    const showLabel = r === 0 || r === 2 || r === 4;
    const cells: React.ReactElement[] = [];
    for (let c = 0; c < cols; c++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + c * 7 + r);
      if (date > today) {
        cells.push(<Text key={c}>{'  '}</Text>);
        continue;
      }
      const value = byDay.get(ymd(date)) ?? 0;
      const lvl = heatmapLevel(value, max);
      cells.push(<Text key={c} color={HEATMAP_COLORS[lvl]}>{'▣ '}</Text>);
    }
    rows.push(
      <Box key={r}>
        <Text>{(showLabel ? dayLabels[r] : '   ').padEnd(5)}</Text>
        {cells}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{'     '}</Text>
        {monthLabels.map((m, i) => <Text key={i}>{m}</Text>)}
      </Box>
      {rows}
      <Box marginTop={1}>
        <Text>{'     '}</Text>
        <Text color="gray">Less </Text>
        {[1, 2, 3, 4].map(lvl => (
          <Text key={lvl} color={HEATMAP_COLORS[lvl]}>{'▣ '}</Text>
        ))}
        <Text color="gray">More</Text>
      </Box>
    </Box>
  );
}

function StatsRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box>
      <Box width={20}><Text color="gray">{label}</Text></Box>
      <Text bold color="white">{value}</Text>
    </Box>
  );
}

interface StatsTabProps {
  core: EngramCore;
  period: Period;
  namespace: string | null;
  focused: boolean;
}

export function StatsTab({ core, period, namespace }: StatsTabProps): React.ReactElement {
  const data = useMemo(() => {
    const periodCfg = PERIODS.find(p => p.id === period)!;
    const sinceMs = periodCfg.days === null ? 0 : Date.now() - periodCfg.days * 86400 * 1000;
    const ns = namespace ?? undefined;

    const heatmapSince = Date.now() - HEATMAP_WEEKS * 7 * 86400 * 1000;
    const byDay = new Map<string, number>();
    for (const d of core.usageLog.byDay(heatmapSince, ns)) byDay.set(d.day, d.tokens);

    const totals = core.usageLog.totals(sinceMs, ns);
    const periodRecords = core.usageLog.rangeRecords(sinceMs, ns);
    const periodActive = new Set<string>();
    for (const r of periodRecords) periodActive.add(ymd(new Date(r.ts)));
    const sessions = detectSessions(periodRecords);
    const longestSessionMs = sessions.reduce((m, s) => Math.max(m, s.endTs - s.startTs), 0);

    const allActive = new Set<string>();
    for (const r of core.usageLog.rangeRecords(0, ns)) allActive.add(ymd(new Date(r.ts)));
    const streakInfo = streaks(allActive);

    const byTool = core.usageLog.byTool(sinceMs, ns);
    const byDayPeriod = core.usageLog.byDay(sinceMs, ns);
    const mostActive = byDayPeriod.length > 0
      ? byDayPeriod.reduce((best, cur) => cur.tokens > best.tokens ? cur : best).day
      : null;

    return {
      byDay, totals, periodActive, sessions, longestSessionMs,
      streakInfo, byTool, mostActive,
      windowDays: periodCfg.days,
    };
  }, [period, namespace, core]);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Activity (last {HEATMAP_WEEKS} weeks)</Text>
      <Box marginTop={1}><Heatmap byDay={data.byDay} /></Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">Stats</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Box width={42}><StatsRow label="Total tokens"    value={fmtNum(data.totals.tokens)} /></Box>
            <StatsRow label="Favorite tool"   value={data.byTool[0]?.tool ?? '—'} />
          </Box>
          <Box>
            <Box width={42}><StatsRow label="Total calls"     value={fmtNum(data.totals.calls)} /></Box>
            <StatsRow label="Longest session" value={data.longestSessionMs > 0 ? fmtDuration(data.longestSessionMs) : '—'} />
          </Box>
          <Box>
            <Box width={42}><StatsRow label="Sessions"        value={fmtNum(data.sessions.length)} /></Box>
            <StatsRow label="Longest streak"  value={`${data.streakInfo.longest} days`} />
          </Box>
          <Box>
            <Box width={42}>
              <StatsRow label="Active days" value={
                data.windowDays !== null
                  ? `${data.periodActive.size} / ${data.windowDays}`
                  : `${data.periodActive.size}`
              } />
            </Box>
            <StatsRow label="Current streak"  value={`${data.streakInfo.current} days`} />
          </Box>
          <Box>
            <Box width={42}><StatsRow label="Most active day" value={data.mostActive ?? '—'} /></Box>
          </Box>
        </Box>
      </Box>

      {data.byTool.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">Top tools</Text>
          <Box marginTop={1} flexDirection="column">
            {data.byTool.slice(0, 5).map(t => {
              const max = data.byTool[0].tokens;
              const width = max > 0 ? Math.round((t.tokens / max) * 24) : 0;
              return (
                <Box key={t.tool}>
                  <Box width={18}><Text color="cyan">{t.tool}</Text></Box>
                  <Box width={10}><Text>{fmtTokens(t.tokens)}</Text></Box>
                  <Box width={28}><Text color="green">{'█'.repeat(width)}{'░'.repeat(24 - width)}</Text></Box>
                  <Text color="gray">{fmtNum(t.calls)} calls</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
