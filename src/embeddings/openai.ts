import type { EmbeddingProvider } from './index.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(options: {
    apiKey?: string;
    model?: string;
    dimension?: number;
    baseUrl?: string;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimension = options.dimension ?? 1536;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';

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
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}
