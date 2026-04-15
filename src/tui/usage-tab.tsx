import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EngramCore } from '../service.js';
import { PERIODS, type Period } from './index.js';

type Breakdown = 'tool' | 'day' | 'namespace';

const BREAKDOWNS: ReadonlyArray<{ id: Breakdown; label: string }> = [
  { id: 'tool',      label: 'By tool' },
  { id: 'day',       label: 'By day' },
  { id: 'namespace', label: 'By namespace' },
];

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
function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

interface UsageTabProps {
  core: EngramCore;
  period: Period;
  namespace: string | null;
  focused: boolean;
}

interface Row { label: string; tokens: number; calls: number; }

export function UsageTab({ core, period, namespace, focused }: UsageTabProps): React.ReactElement {
  const [breakdown, setBreakdown] = useState<Breakdown>('tool');

  useInput((input, key) => {
    if (!focused) return;
    if (key.leftArrow || key.rightArrow) {
      const dir = key.rightArrow ? 1 : -1;
      const ids = BREAKDOWNS.map(b => b.id);
      const idx = ids.indexOf(breakdown);
      setBreakdown(ids[(idx + dir + ids.length) % ids.length]);
    }
  });

  const data = useMemo(() => {
    const cfg = PERIODS.find(p => p.id === period)!;
    const sinceMs = cfg.days === null ? 0 : Date.now() - cfg.days * 86400 * 1000;
    const ns = namespace ?? undefined;

    const totals = core.usageLog.totals(sinceMs, ns);
    let rows: Row[] = [];
    if (breakdown === 'tool') {
      rows = core.usageLog.byTool(sinceMs, ns).map(r => ({ label: r.tool, tokens: r.tokens, calls: r.calls }));
    } else if (breakdown === 'day') {
      rows = core.usageLog.byDay(sinceMs, ns).map(r => ({ label: r.day, tokens: r.tokens, calls: r.calls }));
    } else {
      rows = core.usageLog.byNamespace(sinceMs).map(r => ({ label: r.namespace, tokens: r.tokens, calls: r.calls }));
    }
    return { totals, rows };
  }, [period, namespace, breakdown, core]);

  const max = data.rows[0]?.tokens ?? 0;
  const labelWidth = data.rows.length > 0
    ? Math.max(...data.rows.map(r => r.label.length))
    : 12;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">Breakdown: </Text>
        {BREAKDOWNS.map((b, i) => (
          <Box key={b.id} marginRight={1}>
            <Text
              color={b.id === breakdown ? 'black' : 'gray'}
              backgroundColor={b.id === breakdown ? 'cyan' : undefined}
              bold={b.id === breakdown}
            >{' '}{b.label}{' '}</Text>
            {i < BREAKDOWNS.length - 1 ? <Text color="gray">·</Text> : null}
          </Box>
        ))}
        {focused ? <Text color="cyan">  ←/→</Text> : null}
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
                avg {fmtNum(Math.round(data.totals.tokens / Math.max(1, data.totals.calls)))} tok/call  •  total {fmtDuration(data.totals.durationMs)}
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
            data.rows.slice(0, 12).map(r => {
              const width = max > 0 ? Math.round((r.tokens / max) * 24) : 0;
              return (
                <Box key={r.label}>
                  <Box width={labelWidth + 2}><Text color="cyan">{r.label}</Text></Box>
                  <Box width={10}><Text>{fmtTokens(r.tokens)}</Text></Box>
                  <Box width={6}><Text color="gray">{pct(r.tokens, data.totals.tokens)}</Text></Box>
                  <Box width={28}><Text color="green">{'█'.repeat(width)}{'░'.repeat(24 - width)}</Text></Box>
                  <Text color="gray">{fmtNum(r.calls)} calls</Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
}
