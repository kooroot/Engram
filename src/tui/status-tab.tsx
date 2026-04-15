import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { EngramCore } from '../service.js';
import { getStatus } from '../service.js';

interface StatusTabProps { core: EngramCore; }

export function StatusTab({ core }: StatusTabProps): React.ReactElement {
  const status = useMemo(() => getStatus(core), [core]);

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>Status</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>Memory graph</Text>
        <Box marginTop={1} flexDirection="column">
          <Row label="Active nodes"   value={String(status.activeNodes)} />
          <Row label="Archived nodes" value={String(status.archivedNodes)} />
          <Row label="Active edges"   value={String(status.activeEdges)} />
          <Row label="Total events"   value={String(status.totalEvents)} />
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>Configuration</Text>
        <Box marginTop={1} flexDirection="column">
          <Row label="Namespace"       value={status.namespace} />
          <Row label="Data dir"        value={status.dataDir} />
          <Row label="Embedding"       value={core.config.embedding.provider} />
          <Row label="Semantic search" value={status.semanticEnabled ? 'enabled ✓' : 'disabled'} />
        </Box>
      </Box>

      {core.config.embedding.provider === 'shell' && core.config.embedding.shellCmd ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Embedding command</Text>
          <Text color="gray">  {core.config.embedding.shellCmd}</Text>
        </Box>
      ) : null}

      {core.config.embedding.provider === 'ollama' ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Ollama</Text>
          <Box marginTop={1} flexDirection="column">
            <Row label="URL"   value={core.config.embedding.ollamaUrl ?? 'http://localhost:11434'} />
            <Row label="Model" value={core.config.embedding.ollamaModel ?? 'nomic-embed-text'} />
            <Row label="Dim"   value={String(core.config.embedding.dimension)} />
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray">For full diagnostic, exit and run </Text>
        <Text color="cyan">engram doctor</Text>
      </Box>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box>
      <Box width={22}><Text color="gray">{label}</Text></Box>
      <Text bold>{value}</Text>
    </Box>
  );
}
