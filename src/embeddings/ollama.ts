import type { EmbeddingProvider } from './index.js';

/**
 * Ollama embedding provider — calls a local (or remote) Ollama HTTP API.
 *
 * Default URL:   http://localhost:11434
 * Default model: nomic-embed-text  (768-dim)
 *
 * Setup on user side:
 *   ollama pull nomic-embed-text
 *
 * Env config:
 *   ENGRAM_EMBEDDING_PROVIDER=ollama
 *   OLLAMA_URL=http://localhost:11434      (optional)
 *   OLLAMA_MODEL=nomic-embed-text          (optional)
 *   ENGRAM_EMBEDDING_DIMENSION=768         (optional — must match the model)
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: {
    url?: string;
    model?: string;
    dimension?: number;
    timeoutMs?: number;
  } = {}) {
    this.url = (options.url ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.model = options.model ?? 'nomic-embed-text';
    this.dimension = options.dimension ?? 768;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<number[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error('Ollama returned no embedding (is the model loaded?)');
      }
      if (data.embedding.length !== this.dimension) {
        throw new Error(
          `Ollama dimension mismatch: expected ${this.dimension}, got ${data.embedding.length}. ` +
          `Set ENGRAM_EMBEDDING_DIMENSION to match model "${this.model}".`,
        );
      }
      return data.embedding;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Ollama timed out after ${this.timeoutMs}ms (is ollama running on ${this.url}?)`);
      }
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ECONNREFUSED') {
        throw new Error(`Ollama not reachable at ${this.url}. Start it with: ollama serve`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch in /api/embeddings — call sequentially
    const results: number[][] = [];
    for (const t of texts) results.push(await this.embed(t));
    return results;
  }
}
