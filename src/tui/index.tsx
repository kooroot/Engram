import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { EngramCore } from '../service.js';
import { StatsTab } from './stats-tab.js';
import { UsageTab } from './usage-tab.js';
import { BrowseTab } from './browse-tab.js';
import { StatusTab } from './status-tab.js';

type TabId = 'stats' | 'usage' | 'browse' | 'status';

const TABS: ReadonlyArray<{ id: TabId; label: string; key: string }> = [
  { id: 'stats',  label: 'Stats',  key: '1' },
  { id: 'usage',  label: 'Usage',  key: '2' },
  { id: 'browse', label: 'Browse', key: '3' },
  { id: 'status', label: 'Status', key: '4' },
];

interface AppProps {
  core: EngramCore;
  initialTab?: TabId;
}

export function App({ core, initialTab = 'stats' }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [active, setActive] = useState<TabId>(initialTab);
  const [showHelp, setShowHelp] = useState(false);
  const [, forceTick] = useState(0);

  // Refresh the visible data every 5 s so the heatmap / stats stay live while
  // the user has the TUI open in another terminal.
  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === '?') { setShowHelp(s => !s); return; }
    // Number keys for direct tab jump
    const tab = TABS.find(t => t.key === input);
    if (tab) { setActive(tab.id); return; }
    // Tab / shift-tab + left/right arrow nav.
    // Up/down arrows are NOT consumed here so the active tab can use them
    // for in-tab cursor movement (e.g. Browse list).
    const idx = TABS.findIndex(t => t.id === active);
    if ((key.tab && !key.shift) || key.rightArrow) {
      setActive(TABS[(idx + 1) % TABS.length].id);
      return;
    }
    if ((key.tab && key.shift) || key.leftArrow) {
      setActive(TABS[(idx - 1 + TABS.length) % TABS.length].id);
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <TabBar active={active} />
      <Box flexGrow={1} marginTop={1} flexDirection="column">
        {active === 'stats'  && <StatsTab core={core} />}
        {active === 'usage'  && <UsageTab core={core} />}
        {active === 'browse' && <BrowseTab core={core} />}
        {active === 'status' && <StatusTab core={core} />}
      </Box>
      <Footer showHelp={showHelp} active={active} />
    </Box>
  );
}

function TabBar({ active }: { active: TabId }): React.ReactElement {
  return (
    <Box>
      {TABS.map((t, i) => {
        const isActive = t.id === active;
        return (
          <Box key={t.id} marginRight={2}>
            <Text
              color={isActive ? 'black' : 'cyan'}
              backgroundColor={isActive ? 'cyan' : undefined}
              bold={isActive}
            >
              {' '}{t.key} {t.label}{' '}
            </Text>
            {i < TABS.length - 1 ? <Text color="gray"> · </Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

function Footer({ showHelp, active }: { showHelp: boolean; active: TabId }): React.ReactElement {
  const tabHints: Record<TabId, string> = {
    stats:  'r cycle period · t toggle by-tool',
    usage:  'r cycle period · b cycle breakdown · a all-namespaces',
    browse: '↑/↓ scroll · t cycle type · enter view · backspace back',
    status: '(no tab-specific keys)',
  };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">─────────────────────────────────────────────────────────────</Text>
      <Text color="gray">
        <Text color="cyan">{'←/→'}</Text> tab  <Text color="cyan">{'1-4'}</Text> jump  <Text color="cyan">{'?'}</Text> help  <Text color="cyan">{'q/esc'}</Text> quit  <Text color="white">│</Text>  {tabHints[active]}
      </Text>
      {showHelp ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Global keys</Text>
          <Text color="gray">  tab / shift-tab — next / prev tab</Text>
          <Text color="gray">  1-4 — jump to specific tab</Text>
          <Text color="gray">  ? — toggle this help</Text>
          <Text color="gray">  q or ctrl-c — quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}
