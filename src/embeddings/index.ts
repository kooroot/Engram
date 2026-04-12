/**
 * Embedding provider abstraction.
 * Implementations must convert text to a fixed-dimension float vector.
 */
export interface EmbeddingProvider {
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export { OpenAIEmbeddingProvider } from './openai.js';
export { LocalEmbeddingProvider } from './local.js';
