import type { EmbeddingProvider } from './index.js';

/** HTTP statuses worth retrying: rate-limit, request-timeout, transient 5xx. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

interface TaggedError extends Error {
  /** Explicit retry verdict set by code that constructs the error. */
  retryable?: boolean;
  status?: number;
}

/**
 * Classify an error for retry. Honors an explicit `retryable` tag when present;
 * otherwise treats fetch network failures (TypeError, or an undici `cause.code`)
 * as transient and everything else (JSON parse errors, programmer errors) as
 * fatal.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const tagged = err as TaggedError;
  if (typeof tagged.retryable === 'boolean') return tagged.retryable;
  if (err instanceof TypeError) return true; // fetch network failure
  const cause = (err as { cause?: { code?: string } }).cause;
  return Boolean(cause?.code);
}

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryBackoffMs: number;

  constructor(options: {
    apiKey?: string;
    model?: string;
    dimension?: number;
    baseUrl?: string;
    /** Per-attempt abort deadline. Bounds the auto-embed hook (which
     *  drainCallbacks/closeAsync await) so a stalled API never hangs the
     *  read path or shutdown. Default 30s. */
    timeoutMs?: number;
    /** Extra attempts after the first on a retryable failure (429/5xx/network/
     *  timeout). 0 disables retry. Default 2. */
    maxRetries?: number;
    /** Base for exponential backoff between retries (ms). Internal tuning knob,
     *  not plumbed through config; lowered in tests for speed. Default 250. */
    retryBackoffMs?: number;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimension = options.dimension ?? 1536;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBackoffMs = options.retryBackoffMs ?? 250;

    if (!this.apiKey) {
      throw new Error(
        'OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey option.'
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let lastErr: Error = new Error('OpenAI embedding failed');
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with up to 25% jitter, capped at 8s, so a fleet of
        // hooks retrying after a 429 doesn't thunder back in lockstep.
        const base = Math.min(8_000, this.retryBackoffMs * 2 ** (attempt - 1));
        await sleep(base + base * 0.25 * Math.random());
      }
      try {
        return await this.attempt(texts);
      } catch (err) {
        lastErr = err as Error;
        if (attempt === this.maxRetries || !isRetryable(err)) throw lastErr;
      }
    }
    throw lastErr; // unreachable — loop either returns or throws
  }

  /** One HTTP attempt, bounded by an AbortController timeout. */
  private async attempt(texts: string[]): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimension,
        }),
        signal: ctrl.signal,
      });

      if (!response.ok) {
        const error = await response.text().catch(() => '');
        const e = new Error(
          `OpenAI embedding failed (${response.status}): ${error.slice(0, 200)}`
        ) as TaggedError;
        e.status = response.status;
        e.retryable = RETRYABLE_STATUS.has(response.status);
        throw e;
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        const e = new Error(
          `OpenAI embedding timed out after ${this.timeoutMs}ms`
        ) as TaggedError;
        e.retryable = true; // a stalled request may succeed on retry
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
