import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EngramCore } from '../service.js';
import type { Node } from '../types/index.js';

const PAGE_SIZE = 12;

interface BrowseTabProps {
  core: EngramCore;
  namespace: string | null;  // currently informational; namespace scoping happens at core level
  focused: boolean;
}

export function BrowseTab({ core, focused }: BrowseTabProps): React.ReactElement {
  const [typeFilterIdx, setTypeFilterIdx] = useState(0);   // 0 = all
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Node | null>(null);

  const allNodes = useMemo(() => core.stateTree.searchAllNodes(500), [core]);
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const n of allNodes) set.add(n.type);
    return ['(all)', ...Array.from(set).sort()];
  }, [allNodes]);

  const typeFilter = types[typeFilterIdx] === '(all)' ? null : types[typeFilterIdx];

  const visible = useMemo(() => {
    return typeFilter ? allNodes.filter(n => n.type === typeFilter) : allNodes;
  }, [allNodes, typeFilter]);

  useEffect(() => { setCursor(0); setSelected(null); }, [typeFilterIdx]);

  useInput((input, key) => {
    if (!focused) return;
    if (selected) {
      if (key.return || key.backspace || key.delete) setSelected(null);
      return;
    }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(visible.length - 1, c + 1));
    if (key.return) setSelected(visible[cursor] ?? null);
    if (key.leftArrow || key.rightArrow) {
      const dir = key.rightArrow ? 1 : -1;
      setTypeFilterIdx(i => (i + dir + types.length) % types.length);
    }
  });

  if (selected) return <NodeDetail node={selected} core={core} />;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="gray">Type filter: </Text>
        <Text color="black" backgroundColor="cyan" bold>{' '}{types[typeFilterIdx]}{' '}</Text>
        {focused ? <Text color="cyan">  ←/→</Text> : null}
        <Text color="gray">    {visible.length} nodes</Text>
      </Box>

      {visible.length === 0 ? (
        <Text color="gray">No nodes yet. Use Engram from a connected agent to populate the graph.</Text>
      ) : (
        <>
          <Box>
            <Box width={4}><Text color="gray"> </Text></Box>
            <Box width={16}><Text color="gray">type</Text></Box>
            <Box width={32}><Text color="gray">name</Text></Box>
            <Box width={6}><Text color="gray">conf</Text></Box>
            <Text color="gray">summary</Text>
          </Box>
          {pageSlice(visible, cursor).map((node, i) => {
            const idx = pageStart(cursor) + i;
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
        </>
      )}
    </Box>
  );
}

function pageStart(cursor: number): number { return Math.floor(cursor / PAGE_SIZE) * PAGE_SIZE; }
function pageSlice(arr: Node[], cursor: number): Node[] { return arr.slice(pageStart(cursor), pageStart(cursor) + PAGE_SIZE); }

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
