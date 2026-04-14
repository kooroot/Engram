/**
 * Token-bucket rate limiter for REST API (and reusable for MCP sessions).
 * Per-key buckets refill at a steady rate. No external deps.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  /** Max tokens in the bucket (burst capacity) */
  burst: number;
  /** Tokens added per second (sustained rate) */
  refillPerSecond: number;
  /** Cleanup idle buckets after this many ms */
  idleTimeoutMs: number;
}

export const DEFAULT_LIMIT: RateLimitConfig = {
  burst: 60,
  refillPerSecond: 10,
  idleTimeoutMs: 300_000, // 5 min
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastCleanup = Date.now();

  constructor(public readonly config: RateLimitConfig = DEFAULT_LIMIT) {}

  /**
   * Try to consume one token for the given key.
   * Returns { allowed, retryAfterMs } — retryAfterMs > 0 when denied.
   */
  tryConsume(key: string, tokens: number = 1): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    this.maybeCleanup(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      // Refill based on elapsed time
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      const refilled = elapsedSec * this.config.refillPerSecond;
      bucket.tokens = Math.min(this.config.burst, bucket.tokens + refilled);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true, retryAfterMs: 0 };
    }

    // Compute how long until enough tokens refill
    const deficit = tokens - bucket.tokens;
    const waitSec = deficit / this.config.refillPerSecond;
    return { allowed: false, retryAfterMs: Math.ceil(waitSec * 1000) };
  }

  private maybeCleanup(now: number): void {
    // Only run cleanup every minute to avoid overhead on hot path
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.config.idleTimeoutMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** Current bucket count (for diagnostics) */
  size(): number {
    return this.buckets.size;
  }
}
