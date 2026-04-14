import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/rate-limit.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows burst up to capacity', () => {
    const rl = new RateLimiter({ burst: 5, refillPerSecond: 1, idleTimeoutMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume('client1').allowed).toBe(true);
    }
    expect(rl.tryConsume('client1').allowed).toBe(false);
  });

  it('refills tokens over time', () => {
    const rl = new RateLimiter({ burst: 2, refillPerSecond: 1, idleTimeoutMs: 60_000 });
    rl.tryConsume('x');
    rl.tryConsume('x');
    expect(rl.tryConsume('x').allowed).toBe(false);

    vi.advanceTimersByTime(1500); // 1.5 sec — 1.5 tokens refilled
    expect(rl.tryConsume('x').allowed).toBe(true);
  });

  it('returns retry_after in ms', () => {
    const rl = new RateLimiter({ burst: 1, refillPerSecond: 2, idleTimeoutMs: 60_000 });
    rl.tryConsume('y');
    const result = rl.tryConsume('y');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(500); // 1 token / 2 per sec = 500ms
  });

  it('isolates buckets per key', () => {
    const rl = new RateLimiter({ burst: 2, refillPerSecond: 1, idleTimeoutMs: 60_000 });
    rl.tryConsume('a');
    rl.tryConsume('a');
    expect(rl.tryConsume('a').allowed).toBe(false);
    // b still has full bucket
    expect(rl.tryConsume('b').allowed).toBe(true);
    expect(rl.tryConsume('b').allowed).toBe(true);
  });

  it('cleans up idle buckets after timeout', () => {
    const rl = new RateLimiter({ burst: 5, refillPerSecond: 1, idleTimeoutMs: 1000 });
    rl.tryConsume('ghost');
    expect(rl.size()).toBe(1);

    vi.advanceTimersByTime(65_000); // past cleanup interval + idle
    rl.tryConsume('active'); // triggers cleanup
    expect(rl.size()).toBe(1); // ghost removed, only active remains
  });
});
