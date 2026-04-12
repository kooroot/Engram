import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './index.js';

/**
 * Local deterministic pseudo-embedding provider.
 * Uses hashing to generate consistent vectors — NOT semantically meaningful,
 * but useful for testing and environments without API access.
 *
 * For production semantic search, use OpenAIEmbeddingProvider or similar.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;

  constructor(dimension: number = 1536) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.hashToVector(t));
  }

  private hashToVector(text: string): number[] {
    // Normalize text
    const normalized = text.toLowerCase().trim();

    // Generate enough hash bytes to fill the dimension
    const vector: number[] = [];
    let seed = normalized;

    while (vector.length < this.dimension) {
      const hash = createHash('sha256').update(seed).digest();
      for (let i = 0; i < hash.length && vector.length < this.dimension; i += 4) {
        // Convert 4 bytes to a float in [-1, 1]
        const uint32 = hash.readUInt32LE(i);
        const float = (uint32 / 0xFFFFFFFF) * 2 - 1;
        vector.push(float);
      }
      seed = hash.toString('hex');
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }
}
