/**
 * OpenAIEmbeddingProvider — timeout + bounded-retry behavior (P4-2).
 * Stubs global fetch so no network is touched. retryBackoffMs is forced to ~0
 * so the retry-path tests run instantly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A 200 OK embeddings response with one 3-dim vector per input index. */
function ok(count: number): Response {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({ embedding: [i, i, i], index: i })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const provider = (opts: Record<string, unknown> = {}) =>
  new OpenAIEmbeddingProvider({ apiKey: 'sk-test', dimension: 3, retryBackoffMs: 0, ...opts });

describe('OpenAIEmbeddingProvider', () => {
  it('returns embeddings sorted by index (order preserved)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [
          { embedding: [2, 2, 2], index: 1 },
          { embedding: [1, 1, 1], index: 0 },
        ] }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const out = await provider().embedBatch(['a', 'b']);
    expect(out).toEqual([[1, 1, 1], [2, 2, 2]]);
  });

  it('times out a stalled request and reports it (no retry)', async () => {
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_res, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    ) as typeof fetch;

    await expect(
      provider({ timeoutMs: 20, maxRetries: 0 }).embedBatch(['x']),
    ).rejects.toThrow(/timed out after 20ms/i);
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1 ? new Response('rate limited', { status: 429 }) : ok(1);
    }) as typeof fetch;

    const out = await provider({ maxRetries: 2 }).embedBatch(['hello']);
    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('does NOT retry a 400 (non-retryable) — one attempt only', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;

    await expect(provider({ maxRetries: 2 }).embedBatch(['x'])).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('exhausts retries on persistent 500 (maxRetries + 1 attempts)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('server error', { status: 500 });
    }) as typeof fetch;

    await expect(provider({ maxRetries: 2 }).embedBatch(['x'])).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });

  it('retries a network failure (fetch throws TypeError)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return ok(1);
    }) as typeof fetch;

    const out = await provider({ maxRetries: 2 }).embedBatch(['x']);
    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('throws synchronously when constructed without an API key', () => {
    expect(() => new OpenAIEmbeddingProvider({ apiKey: '' })).toThrow(/API key required/);
  });
});
