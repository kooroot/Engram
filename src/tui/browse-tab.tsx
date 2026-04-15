import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EngramCore } from '../service.js';
import type { Node } from '../types/index.js';

const PAGE_SIZE = 12;

interface BrowseTabProps { core: EngramCore; }

export function BrowseTab({ core }: BrowseTabProps): React.ReactElement {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Node | null>(null);

  // Discover available types
  const allNodes = useMemo(() => core.stateTree.searchAllNodes(500), [core]);
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const n of allNodes) set.add(n.type);
    return Array.from(set).sort();
  }, [allNodes]);

  const visible = useMemo(() => {
    return typeFilter ? allNodes.filter(n => n.type === typeFilter) : allNodes;
  }, [allNodes, typeFilter]);

  // Reset cursor when the filter changes
  React.useEffect(() => { setCursor(0); setSelected(null); }, [typeFilter]);

  useInput((input, key) => {
    // Global keys (esc / q / ctrl-c) are handled by App's useInput and quit
    // the whole TUI — don't shadow them here. Use enter or backspace to close
    // the node detail view.
    if (selected) {
      if (key.return || key.backspace || key.delete) setSelected(null);
      return;
    }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(visible.length - 1, c + 1));
    if (key.return) setSelected(visible[cursor] ?? null);
    if (input === 't') {
      // cycle type filter: null → types[0] → types[1] → ... → null
      const idx = typeFilter === null ? -1 : types.indexOf(typeFilter);
      const next = idx + 1 >= types.length ? null : types[idx + 1];
      setTypeFilter(next);
    }
  });

  if (selected) return <NodeDetail node={selected} core={core} />;

  if (visible.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>Browse</Text>
        <Box marginTop={1}><Text color="gray">No nodes yet. Try `engram` MCP from a connected agent first.</Text></Box>
      </Box>
    );
  }

  const pageStart = Math.floor(cursor / PAGE_SIZE) * PAGE_SIZE;
  const page = visible.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>Browse</Text>
        <Text color="gray">  {visible.length} nodes  </Text>
        <Text color="gray">·  Filter: </Text>
        <Text color={typeFilter ? 'magenta' : 'gray'}>{typeFilter ?? 'all'}</Text>
      </Box>
      <Box>
        <Box width={4}><Text color="gray"> </Text></Box>
        <Box width={16}><Text color="gray">type</Text></Box>
        <Box width={32}><Text color="gray">name</Text></Box>
        <Box width={6}><Text color="gray">conf</Text></Box>
        <Text color="gray">summary</Text>
      </Box>
      {page.map((node, i) => {
        const idx = pageStart + i;
        const isCursor = idx === cursor;
        return (
          <Box key={node.id}>
            <Box width={4}>
              <Text color={isCursor ? 'cyan' : 'gray'}>{isCursor ? '▶ ' : '  '}</Text>
            </Box>
            <Box width={16}>
              <Text color={isCursor ? 'cyan' : 'magenta'}>{node.type}</Text>
            </Box>
            <Box width={32}>
              <Text bold={isCursor} color={isCursor ? 'white' : undefined}>
                {truncate(node.name, 30)}
              </Text>
            </Box>
            <Box width={6}>
              <Text color="gray">{node.confidence < 1 ? node.confidence.toFixed(2) : '   '}</Text>
            </Box>
            <Text color="gray">{truncate(node.summary ?? '', 60)}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">
          {cursor + 1} / {visible.length}  ·  page {Math.floor(cursor / PAGE_SIZE) + 1}/{Math.ceil(visible.length / PAGE_SIZE)}
        </Text>
      </Box>
    </Box>
  );
}

function NodeDetail({ node, core }: { node: Node; core: EngramCore }): React.ReactElement {
  const out = core.stateTree.getEdgesFrom(node.id);
  const inn = core.stateTree.getEdgesTo(node.id);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{node.name}</Text>
        <Text color="gray">  [</Text>
        <Text color="magenta">{node.type}</Text>
        <Text color="gray">]  conf {node.confidence.toFixed(2)}  v{node.version}{node.archived ? '  (archived)' : ''}</Text>
      </Box>
      {node.summary ? <Box marginTop={1}><Text>{node.summary}</Text></Box> : null}

      {Object.keys(node.properties).length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Properties</Text>
          {Object.entries(node.properties).slice(0, 12).map(([k, v]) => (
            <Box key={k}>
              <Box width={20}><Text color="gray">{k}</Text></Box>
              <Text>{truncate(typeof v === 'string' ? v : JSON.stringify(v), 60)}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {out.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Outgoing edges ({out.length})</Text>
          {out.slice(0, 10).map(e => (
            <Text key={e.id} color="gray">  → {e.predicate} → {truncate(e.target_id, 40)}</Text>
          ))}
        </Box>
      ) : null}

      {inn.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Incoming edges ({inn.length})</Text>
          {inn.slice(0, 10).map(e => (
            <Text key={e.id} color="gray">  ← {e.predicate} ← {truncate(e.source_id, 40)}</Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray">enter or backspace to go back  ·  esc/q to quit</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
