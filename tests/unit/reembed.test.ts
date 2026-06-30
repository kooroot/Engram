/**
 * reembedNamespace — backfill / refresh of node embeddings (P4-3).
 * Uses disableAutoEmbed so created nodes start with NO vectors, exactly the
 * "embeddings enabled after data already existed" backfill case. A counting
 * mock provider stands in for OpenAI/Ollama (no network).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEngramCore, reembedNamespace, type EngramCore } from '../../src/service.js';
import type { EmbeddingProvider } from '../../src/embeddings/index.js';

class CountingProvider implements EmbeddingProvider {
  readonly dimension: number;
  batchCalls = 0;
  totalEmbedded = 0;
  constructor(dimension = 4) { this.dimension = dimension; }
  async embed(text: string): Promise<number[]> { return (await this.embedBatch([text]))[0]; }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchCalls++;
    this.totalEmbedded += texts.length;
    // Deterministic non-zero unit-ish vector of the right width.
    return texts.map(() => Array.from({ length: this.dimension }, (_, i) => (i === 0 ? 1 : 0)));
  }
}

let tmpDir: string;

describe('reembedNamespace', () => {
  let core: EngramCore;
  let provider: CountingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-reembed-'));
    provider = new CountingProvider(4);
    // disableAutoEmbed → nodes are created WITHOUT vectors (the backfill case),
    // while the provider + vec table are still wired up for reembed to use.
    core = createEngramCore(
      { dataDir: tmpDir, namespace: 'default', embedding: { provider: 'local', dimension: 4 } },
      { embeddingProvider: provider, disableAutoEmbed: true },
    );
    core.stateTree.mutate([
      { op: 'create', type: 'concept', name: 'Alpha' },
      { op: 'create', type: 'concept', name: 'Beta' },
      { op: 'create', type: 'concept', name: 'Gamma' },
    ]);
  });

  afterEach(async () => {
    await core.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills only nodes missing a vector, and is a no-op on a second run', async () => {
    expect(core.vectorStore.liveSourceIds('node').size).toBe(0); // none embedded yet

    const r1 = await reembedNamespace(core, {});
    expect(r1).toMatchObject({ totalNodes: 3, alreadyEmbedded: 0, toEmbed: 3, embedded: 3, dryRun: false });
    expect(provider.totalEmbedded).toBe(3);
    expect(core.vectorStore.liveSourceIds('node').size).toBe(3);

    const before = provider.totalEmbedded;
    const r2 = await reembedNamespace(core, {});
    expect(r2).toMatchObject({ alreadyEmbedded: 3, toEmbed: 0, embedded: 0 });
    expect(provider.totalEmbedded).toBe(before); // provider not called again
  });

  it('--force re-embeds every node even when all already have vectors', async () => {
    await reembedNamespace(core, {});            // initial backfill
    const before = provider.totalEmbedded;       // 3

    const r = await reembedNamespace(core, { force: true });
    expect(r).toMatchObject({ toEmbed: 3, embedded: 3 });
    expect(provider.totalEmbedded).toBe(before + 3);
    expect(core.vectorStore.liveSourceIds('node').size).toBe(3); // still exactly 3 (overwrite, no dup)
  });

  it('--dry-run reports work without calling the provider or writing vectors', async () => {
    const r = await reembedNamespace(core, { dryRun: true });
    expect(r).toMatchObject({ totalNodes: 3, toEmbed: 3, embedded: 0, dryRun: true });
    expect(provider.totalEmbedded).toBe(0);
    expect(core.vectorStore.liveSourceIds('node').size).toBe(0);
  });

  it('honors batchSize (one provider call per batch)', async () => {
    await reembedNamespace(core, { batchSize: 2 }); // 3 nodes → ceil(3/2) = 2 calls
    expect(provider.batchCalls).toBe(2);
    expect(provider.totalEmbedded).toBe(3);
  });
});

describe('reembedNamespace — guards', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when no embedding provider is configured', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-reembed-noprov-'));
    const core = createEngramCore({ dataDir: tmpDir, namespace: 'default' });
    try {
      await expect(reembedNamespace(core, {})).rejects.toThrow(/embedding provider/i);
    } finally {
      await core.closeAsync();
    }
  });

  it('refuses to backfill when the provider dimension differs from the vec table', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-reembed-dim-'));

    // First core creates the vec table as float[4].
    const core4 = createEngramCore(
      { dataDir: tmpDir, namespace: 'default', embedding: { provider: 'local', dimension: 4 } },
      { embeddingProvider: new CountingProvider(4), disableAutoEmbed: true },
    );
    core4.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Alpha' }]);
    await core4.closeAsync();

    // Reopen the SAME data dir with an 8-dim provider — table stays float[4].
    const core8 = createEngramCore(
      { dataDir: tmpDir, namespace: 'default', embedding: { provider: 'local', dimension: 8 } },
      { embeddingProvider: new CountingProvider(8), disableAutoEmbed: true },
    );
    try {
      expect(core8.vectorStore.tableDimension()).toBe(4);
      await expect(reembedNamespace(core8, {})).rejects.toThrow(/dimension/i);
    } finally {
      await core8.closeAsync();
    }
  });
});
