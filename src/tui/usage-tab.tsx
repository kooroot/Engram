import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EngramCore } from '../service.js';

type Period = 'day' | 'week' | 'month' | 'all';
type Breakdown = 'tool' | 'day' | 'namespace';

const PERIODS: ReadonlyArray<{ id: Period; label: string; days: number | null }> = [
  { id: 'day',   label: 'Last 24h',  days: 1 },
  { id: 'week',  label: 'Last 7d',   days: 7 },
  { id: 'month', label: 'Last 30d',  days: 30 },
  { id: 'all',   label: 'All time',  days: null },
];

const BREAKDOWNS: ReadonlyArray<{ id: Breakdown; label: string }> = [
  { id: 'tool',      label: 'By tool' },
  { id: 'day',       label: 'By day' },
  { id: 'namespace', label: 'By namespace' },
];

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
function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function PeriodPills({ active }: { active: Period }): React.ReactElement {
  return (
    <Box>
      {PERIODS.map((p, i) => (
        <Box key={p.id} marginRight={1}>
          <Text color={p.id === active ? 'black' : 'gray'} backgroundColor={p.id === active ? '#ff9a5a' : undefined} bold={p.id === active}>
            {' '}{p.label}{' '}
          </Text>
          {i < PERIODS.length - 1 ? <Text color="gray">·</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function BreakdownPills({ active }: { active: Breakdown }): React.ReactElement {
  return (
    <Box>
      {BREAKDOWNS.map((b, i) => (
        <Box key={b.id} marginRight={1}>
          <Text color={b.id === active ? 'black' : 'gray'} backgroundColor={b.id === active ? 'cyan' : undefined} bold={b.id === active}>
            {' '}{b.label}{' '}
          </Text>
          {i < BREAKDOWNS.length - 1 ? <Text color="gray">·</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

interface Row { label: string; tokens: number; calls: number; }

function BarRow({ row, max, totalTokens, labelWidth }: { row: Row; max: number; totalTokens: number; labelWidth: number }): React.ReactElement {
  const width = max > 0 ? Math.round((row.tokens / max) * 24) : 0;
  const bar = '█'.repeat(width) + '░'.repeat(24 - width);
  return (
    <Box>
      <Box width={labelWidth + 2}><Text color="cyan">{row.label}</Text></Box>
      <Box width={10}><Text>{fmtTokens(row.tokens)}</Text></Box>
      <Box width={6}><Text color="gray">{pct(row.tokens, totalTokens)}</Text></Box>
      <Box width={28}><Text color="green">{bar}</Text></Box>
      <Text color="gray">{fmtNum(row.calls)} calls</Text>
    </Box>
  );
}

interface UsageTabProps { core: EngramCore; }

export function UsageTab({ core }: UsageTabProps): React.ReactElement {
  const [period, setPeriod] = useState<Period>('week');
  const [breakdown, setBreakdown] = useState<Breakdown>('tool');
  const [allNs, setAllNs] = useState(false);

  useInput((input) => {
    if (input === 'r') {
      const idx = PERIODS.findIndex(p => p.id === period);
      setPeriod(PERIODS[(idx + 1) % PERIODS.length].id);
    }
    if (input === 'b') {
      const idx = BREAKDOWNS.findIndex(b => b.id === breakdown);
      setBreakdown(BREAKDOWNS[(idx + 1) % BREAKDOWNS.length].id);
    }
    if (input === 'a') setAllNs(s => !s);
  });

  const data = useMemo(() => {
    const cfg = PERIODS.find(p => p.id === period)!;
    const sinceMs = cfg.days === null ? 0 : Date.now() - cfg.days * 86400 * 1000;
    const ns = allNs ? undefined : core.config.namespace;

    const totals = core.usageLog.totals(sinceMs, ns);
    let rows: Row[] = [];
    if (breakdown === 'tool') {
      rows = core.usageLog.byTool(sinceMs, ns).map(r => ({ label: r.tool, tokens: r.tokens, calls: r.calls }));
    } else if (breakdown === 'day') {
      rows = core.usageLog.byDay(sinceMs, ns).map(r => ({ label: r.day, tokens: r.tokens, calls: r.calls }));
    } else {
      rows = core.usageLog.byNamespace(sinceMs).map(r => ({ label: r.namespace, tokens: r.tokens, calls: r.calls }));
    }

    return { totals, rows, ns: allNs ? 'all namespaces' : `namespace=${core.config.namespace}` };
  }, [period, breakdown, allNs, core]);

  const max = data.rows[0]?.tokens ?? 0;
  const labelWidth = data.rows.length > 0
    ? Math.max(...data.rows.map(r => r.label.length))
    : 12;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <PeriodPills active={period} />
        </Box>
        <BreakdownPills active={breakdown} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">Totals</Text>
        <Box marginTop={1}>
          {data.totals.calls === 0 ? (
            <Text color="gray">  No tool calls in this window.</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                <Text bold>{fmtNum(data.totals.tokens)}</Text> tokens  •  <Text bold>{fmtNum(data.totals.calls)}</Text> calls
              </Text>
              <Text color="gray">
                avg {fmtNum(Math.round(data.totals.tokens / Math.max(1, data.totals.calls)))} tok/call  •  total {fmtDuration(data.totals.durationMs)}  •  {data.ns}
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">{BREAKDOWNS.find(b => b.id === breakdown)!.label}</Text>
        <Box marginTop={1} flexDirection="column">
          {data.rows.length === 0 ? (
            <Text color="gray">  (no data)</Text>
          ) : (
            data.rows.slice(0, 12).map(r => (
              <BarRow key={r.label} row={r} max={max} totalTokens={data.totals.tokens} labelWidth={labelWidth} />
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}
