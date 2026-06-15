import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const ENV_KEYS = [
  'ENGRAM_NO_ENV_FILE',
  'ENGRAM_DATA_DIR',
  'ENGRAM_DB_FILENAME',
  'ENGRAM_VEC_DB_FILENAME',
  'ENGRAM_NAMESPACE',
  'ENGRAM_HISTORY_KEEP_VERSIONS',
  'ENGRAM_EMBEDDING_PROVIDER',
  'ENGRAM_EMBEDDING_DIMENSION',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ENGRAM_EMBEDDING_CMD',
  'ENGRAM_EMBEDDING_TIMEOUT_MS',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'ENGRAM_DEDUP_SEMANTIC',
  'ENGRAM_DEDUP_SEMANTIC_THRESHOLD',
] as const;

describe('loadConfig', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    saved.clear();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env['ENGRAM_NO_ENV_FILE'] = '1';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('defaults node_history retention to 20 snapshots plus original v1', () => {
    const config = loadConfig();
    expect(config.maintenance.historyKeepVersions).toBe(20);
  });

  it('reads node_history retention from ENGRAM_HISTORY_KEEP_VERSIONS', () => {
    process.env['ENGRAM_HISTORY_KEEP_VERSIONS'] = '0';
    const config = loadConfig();
    expect(config.maintenance.historyKeepVersions).toBe(0);
  });

  it('lets explicit maintenance overrides win over env vars', () => {
    process.env['ENGRAM_HISTORY_KEEP_VERSIONS'] = '3';
    const config = loadConfig({ maintenance: { historyKeepVersions: 7 } });
    expect(config.maintenance.historyKeepVersions).toBe(7);
  });
});
