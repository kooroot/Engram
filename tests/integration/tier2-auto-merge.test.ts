/**
 * Post-hoc Tier 2 auto-merge — end-to-end integration test.
 * Wires a deterministic mock embedding provider into createEngramCore with
 * dedup.semanticAutoMerge=true, inserts two nodes whose names don't match
 * any Tier 1 heuristic (no shared tokens, no substring) but whose mock
 * embeddings are near-identical. After draining the async auto-embed
 * callback, the later-inserted node should be merged into the first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEngramCore, type EngramCore } from '../../src/service.js';
import type { EmbeddingProvider } from '../../src/embeddings/index.js';

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 4;
  /** textKey → embedding. Tests set these before inserts. */
  readonly vectors = new Map<string, number[]>();
  /** Instrumentation for the skip-unchanged re-embed guard. */
  batchCalls = 0;
  totalEmbedded = 0;

  async embed(text: string): Promise<number[]> {
    return this.lookup(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchCalls++;
    this.totalEmbedded += texts.length;
    return texts.map(t => this.lookup(t));
  }
  private lookup(text: string): number[] {
    for (const [key, vec] of this.vectors) {
      if (text.includes(key)) return vec;
    }
    return [0, 0, 0, 1]; // default orthogonal
  }
}

let tmpDir: string;

describe('Tier 2 post-hoc auto-merge', () => {
  let core: EngramCore;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-tier2-'));
    provider = new MockEmbeddingProvider();
    core = createEngramCore(
      {
        dataDir: tmpDir,
        namespace: 'default',
        embedding: { provider: 'local', dimension: 4 },
        dedup: { semanticAutoMerge: true, semanticThreshold: 0.95 },
      },
      { embeddingProvider: provider },
    );
  });

  afterEach(async () => {
    await core.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges semantically near-identical nodes of the same type', async () => {
    // Name tokens disjoint → Tier 1 cannot match these
    provider.vectors.set('Authentication', [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('Login flow',      [0.99, 0.141, 0.0, 0.0]); // cos ≈ 0.99

    const r1 = core.stateTree.mutate([
      { op: 'create', type: 'concept', name: 'Authentication' },
    ]);
    const firstId = r1.results[0]!.node_id;

    const r2 = core.stateTree.mutate([
      { op: 'create', type: 'concept', name: 'Login flow' },
    ]);
    const secondId = r2.results[0]!.node_id;

    // At mutate()-return time neither auto-embed nor Tier 2 has run yet —
    // both nodes still active (Tier 1 can't match these names).
    expect(r2.results[0]!.auto_merged).toBeUndefined();

    // Drain the async onMutate chain (auto-embed → Tier 2 check → mergeNodes)
    await core.stateTree.drainCallbacks();

    const first = core.stateTree.getNode(firstId);
    const second = core.stateTree.getNode(secondId);

    // Exactly one should be archived; the other is canonical.
    const archivedCount = [first, second].filter(n => n?.archived).length;
    expect(archivedCount).toBe(1);
  });

  it('does NOT merge across different types even with identical embeddings', async () => {
    provider.vectors.set('Alpha', [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('Beta',  [1.0, 0.0, 0.0, 0.0]); // identical

    const r1 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Alpha' }]);
    const r2 = core.stateTree.mutate([{ op: 'create', type: 'project', name: 'Beta' }]);

    await core.stateTree.drainCallbacks();

    expect(core.stateTree.getNode(r1.results[0]!.node_id)?.archived).toBe(false);
    expect(core.stateTree.getNode(r2.results[0]!.node_id)?.archived).toBe(false);
  });

  it('leaves dissimilar nodes alone', async () => {
    provider.vectors.set('North', [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('South', [0.0, 0.0, 1.0, 0.0]); // orthogonal

    const r1 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'North' }]);
    const r2 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'South' }]);

    await core.stateTree.drainCallbacks();

    expect(core.stateTree.getNode(r1.results[0]!.node_id)?.archived).toBe(false);
    expect(core.stateTree.getNode(r2.results[0]!.node_id)?.archived).toBe(false);
  });

  it('respects threshold (below threshold → no merge)', async () => {
    provider.vectors.set('Alpha', [1.0, 0.0, 0.0, 0.0]);
    // cos(Alpha, Bravo) ≈ 0.85 → below default 0.95 threshold
    provider.vectors.set('Bravo', [0.85, Math.sqrt(1 - 0.85*0.85), 0.0, 0.0]);

    const r1 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Alpha' }]);
    const r2 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Bravo' }]);

    await core.stateTree.drainCallbacks();

    expect(core.stateTree.getNode(r1.results[0]!.node_id)?.archived).toBe(false);
    expect(core.stateTree.getNode(r2.results[0]!.node_id)?.archived).toBe(false);
  });
});

describe('Tier 2 post-hoc auto-merge (disabled)', () => {
  let core: EngramCore;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-tier2-off-'));
    provider = new MockEmbeddingProvider();
    core = createEngramCore(
      {
        dataDir: tmpDir,
        namespace: 'default',
        embedding: { provider: 'local', dimension: 4 },
        // semanticAutoMerge defaults to false
      },
      { embeddingProvider: provider },
    );
  });

  afterEach(async () => {
    await core.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not merge even when embeddings are identical (feature off)', async () => {
    provider.vectors.set('Alpha', [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('Beta',  [1.0, 0.0, 0.0, 0.0]);

    const r1 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Alpha' }]);
    const r2 = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Beta' }]);

    await core.stateTree.drainCallbacks();

    expect(core.stateTree.getNode(r1.results[0]!.node_id)?.archived).toBe(false);
    expect(core.stateTree.getNode(r2.results[0]!.node_id)?.archived).toBe(false);
  });
});

describe('auto-embed skip-unchanged guard', () => {
  let core: EngramCore;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-reembed-'));
    provider = new MockEmbeddingProvider();
    core = createEngramCore(
      {
        dataDir: tmpDir,
        namespace: 'default',
        embedding: { provider: 'local', dimension: 4 },
        // semanticAutoMerge off → isolates the re-embed guard from any merge.
      },
      { embeddingProvider: provider },
    );
  });

  afterEach(async () => {
    await core.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('embeds on create but not on a confidence-only update; re-embeds when the embed-input changes', async () => {
    provider.vectors.set('Widget', [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('Widget v2', [0.0, 1.0, 0.0, 0.0]);

    const r = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Widget' }]);
    const id = r.results[0]!.node_id;
    await core.stateTree.drainCallbacks();
    const embeddedAfterCreate = provider.totalEmbedded;
    expect(embeddedAfterCreate).toBe(1); // first create embeds exactly once

    // confidence-only update: embed-input ('Widget [concept]: {}') is unchanged
    // → guard must skip, embedBatch must NOT be invoked for it.
    core.stateTree.mutate([{ op: 'update', node_id: id, confidence: 0.5 }]);
    await core.stateTree.drainCallbacks();
    expect(provider.totalEmbedded).toBe(embeddedAfterCreate);

    // name change: embed-input becomes 'Widget v2 [concept]: {}' → must re-embed.
    core.stateTree.mutate([{ op: 'update', node_id: id, name: 'Widget v2' }]);
    await core.stateTree.drainCallbacks();
    expect(provider.totalEmbedded).toBe(embeddedAfterCreate + 1);

    // the stored embed-text now reflects the new name, backed by a live vector.
    expect(core.vectorStore.getStoredEmbedText('node', id)).toBe('Widget v2 [concept]: {}');
  });

  it('does not re-embed link() endpoints whose embed-input is unchanged', async () => {
    provider.vectors.set('Apple',  [1.0, 0.0, 0.0, 0.0]);
    provider.vectors.set('Orange', [0.0, 0.0, 1.0, 0.0]); // orthogonal → no merge anyway

    const a = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Apple' }]).results[0]!.node_id;
    const b = core.stateTree.mutate([{ op: 'create', type: 'concept', name: 'Orange' }]).results[0]!.node_id;
    await core.stateTree.drainCallbacks();
    const embeddedAfterCreates = provider.totalEmbedded;
    expect(embeddedAfterCreates).toBe(2);

    // link fires onMutate for BOTH endpoints; neither node's text changed.
    core.stateTree.link([{ op: 'create', source_id: a, predicate: 'relates_to', target_id: b }]);
    await core.stateTree.drainCallbacks();
    expect(provider.totalEmbedded).toBe(embeddedAfterCreates); // endpoints not re-embedded

    // both original vectors survive the no-op (text still backed by a live row).
    expect(core.vectorStore.getStoredEmbedText('node', a)).toBe('Apple [concept]: {}');
    expect(core.vectorStore.getStoredEmbedText('node', b)).toBe('Orange [concept]: {}');
  });
});
