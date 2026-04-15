import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { EngramCore } from '../service.js';
import { listNamespaces } from '../service.js';
import { StatsTab } from './stats-tab.js';
import { UsageTab } from './usage-tab.js';
import { BrowseTab } from './browse-tab.js';
import { StatusTab } from './status-tab.js';

export type TabId = 'stats' | 'usage' | 'browse' | 'status';
export type Period = 'day' | 'week' | 'month' | 'all';
export type FocusArea = 'tabs' | 'period' | 'namespace' | 'body';

export const PERIODS: ReadonlyArray<{ id: Period; label: string; days: number | null }> = [
  { id: 'day',   label: 'Last 24h',  days: 1 },
  { id: 'week',  label: 'Last 7d',   days: 7 },
  { id: 'month', label: 'Last 30d',  days: 30 },
  { id: 'all',   label: 'All time',  days: null },
];

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'stats',  label: 'Stats'  },
  { id: 'usage',  label: 'Usage'  },
  { id: 'browse', label: 'Browse' },
  { id: 'status', label: 'Status' },
];

const FOCUS_RING: readonly FocusArea[] = ['tabs', 'period', 'namespace', 'body'] as const;

interface AppProps {
  core: EngramCore;
}

export function App({ core }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>('stats');
  const [period, setPeriod] = useState<Period>('week');
  const [namespaceMode, setNamespaceMode] = useState<string>(core.config.namespace);
  const [focus, setFocus] = useState<FocusArea>('tabs');
  const [showHelp, setShowHelp] = useState(false);
  const [, forceTick] = useState(0);

  // Available namespaces for cycling. Always includes "(all)" and the current namespace.
  const namespaceOptions = useMemo<string[]>(() => {
    const known = listNamespaces(core);
    const set = new Set<string>(['(all)', core.config.namespace, ...known]);
    return Array.from(set);
  }, [core]);

  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  function cycle<T>(arr: readonly T[], cur: T, dir: 1 | -1): T {
    const idx = arr.indexOf(cur);
    if (idx === -1) return arr[0];
    return arr[(idx + dir + arr.length) % arr.length];
  }

  useInput((input, key) => {
    // Global quit
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) { exit(); return; }
    // Help
    if (input === '?') { setShowHelp(s => !s); return; }

    // Tab key cycles focus area
    if (key.tab && !key.shift) {
      setFocus(cycle(FOCUS_RING, focus, 1));
      return;
    }
    if (key.tab && key.shift) {
      setFocus(cycle(FOCUS_RING, focus, -1));
      return;
    }

    // Arrow keys: behavior depends on focus
    if (key.leftArrow || key.rightArrow) {
      const dir = key.rightArrow ? 1 : -1;
      if (focus === 'tabs') {
        const tabIds = TABS.map(t => t.id);
        setActiveTab(cycle(tabIds, activeTab, dir));
      } else if (focus === 'period') {
        const periodIds = PERIODS.map(p => p.id);
        setPeriod(cycle(periodIds, period, dir));
      } else if (focus === 'namespace') {
        setNamespaceMode(cycle(namespaceOptions, namespaceMode, dir));
      }
      // focus === 'body': forwarded to the active tab via `focused` prop +
      // its own useInput. Do not consume here.
    }

    // Up/down arrows: only the active tab body uses these — don't consume.
  });

  const namespaceFilter = namespaceMode === '(all)' ? null : namespaceMode;
  const bodyFocused = focus === 'body';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <TabBar active={activeTab} focused={focus === 'tabs'} />
      <HeaderStrip
        period={period}
        namespaceMode={namespaceMode}
        focusedField={focus}
      />
      <Box flexGrow={1} marginTop={1} flexDirection="column">
        {activeTab === 'stats'  && <StatsTab  core={core} period={period} namespace={namespaceFilter} focused={bodyFocused} />}
        {activeTab === 'usage'  && <UsageTab  core={core} period={period} namespace={namespaceFilter} focused={bodyFocused} />}
        {activeTab === 'browse' && <BrowseTab core={core}                  namespace={namespaceFilter} focused={bodyFocused} />}
        {activeTab === 'status' && <StatusTab core={core}                  namespace={namespaceFilter} />}
      </Box>
      <Footer focus={focus} activeTab={activeTab} showHelp={showHelp} />
    </Box>
  );
}

function TabBar({ active, focused }: { active: TabId; focused: boolean }): React.ReactElement {
  return (
    <Box>
      {focused ? <Text color="cyan">‹ </Text> : <Text>  </Text>}
      {TABS.map((t, i) => {
        const isActive = t.id === active;
        return (
          <Box key={t.id} marginRight={1}>
            <Text
              color={isActive ? 'black' : 'cyan'}
              backgroundColor={isActive ? 'cyan' : undefined}
              bold={isActive}
            >
              {' '}{t.label}{' '}
            </Text>
            {i < TABS.length - 1 ? <Text color="gray">·</Text> : null}
          </Box>
        );
      })}
      {focused ? <Text color="cyan">›</Text> : null}
    </Box>
  );
}

function HeaderStrip({ period, namespaceMode, focusedField }: {
  period: Period;
  namespaceMode: string;
  focusedField: FocusArea;
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Box marginRight={3}>
        <Text color="gray">Period: </Text>
        {focusedField === 'period' ? <Text color="cyan">‹ </Text> : null}
        <Text color="black" backgroundColor="#ff9a5a" bold>{' '}{labelForPeriod(period)}{' '}</Text>
        {focusedField === 'period' ? <Text color="cyan">›</Text> : null}
      </Box>
      <Box>
        <Text color="gray">Namespace: </Text>
        {focusedField === 'namespace' ? <Text color="cyan">‹ </Text> : null}
        <Text color="black" backgroundColor="cyan" bold>{' '}{namespaceMode}{' '}</Text>
        {focusedField === 'namespace' ? <Text color="cyan">›</Text> : null}
      </Box>
    </Box>
  );
}

function labelForPeriod(p: Period): string {
  return PERIODS.find(x => x.id === p)?.label ?? p;
}

function Footer({ focus, activeTab, showHelp }: { focus: FocusArea; activeTab: TabId; showHelp: boolean }): React.ReactElement {
  const focusLabel: Record<FocusArea, string> = {
    tabs:      'Focus: Tabs       — ←/→ switch tab',
    period:    'Focus: Period     — ←/→ cycle period',
    namespace: 'Focus: Namespace  — ←/→ cycle namespace',
    body:      bodyHint(activeTab),
  };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">─────────────────────────────────────────────────────────────</Text>
      <Text color="gray">
        <Text color="cyan">{'tab'}</Text> next focus  <Text color="cyan">{'shift-tab'}</Text> prev focus  <Text color="cyan">{'?'}</Text> help  <Text color="cyan">{'q/esc'}</Text> quit
      </Text>
      <Text color="cyan">{focusLabel[focus]}</Text>
      {showHelp ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Keyboard</Text>
          <Text color="gray">  tab / shift-tab — cycle focus area (tabs ↔ period ↔ namespace ↔ body)</Text>
          <Text color="gray">  ← / →           — cycle items in the focused area</Text>
          <Text color="gray">  ↑ / ↓           — only used when focus is on body (Browse list cursor)</Text>
          <Text color="gray">  enter           — activate (open Browse detail, etc.)</Text>
          <Text color="gray">  ?               — toggle this help</Text>
          <Text color="gray">  q / esc         — quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function bodyHint(tab: TabId): string {
  if (tab === 'stats')  return 'Focus: Body       — (Stats has no in-body controls)';
  if (tab === 'usage')  return 'Focus: Body       — ←/→ cycle breakdown (tool / day / namespace)';
  if (tab === 'browse') return 'Focus: Body       — ↑/↓ cursor · enter view · ←/→ cycle type filter';
  return 'Focus: Body       — (Status has no in-body controls)';
}
