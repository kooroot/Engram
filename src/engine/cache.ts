import { metrics } from '../metrics.js';

export interface CacheConfig {
  contextCacheSize: number;
  contextTTLMs: number;
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  contextCacheSize: 100,
  contextTTLMs: 60_000,    // 1 minute
};

interface CachedContext {
  key: string;
  result: string;
  nodeIds: Set<string>;
  cachedAt: number;
}

/**
 * In-memory LRU + TTL cache for get_context results, invalidated whenever a
 * node it references is mutated.
 *
 * A node-level cache used to live here but was never populated — StateTree
 * reads go straight to SQLite, which is a fast indexed point lookup — so it
 * only added dead eviction code and a misleading "reads are cached" signal.
 * Removed in the Step-0 cleanup; the read-path N+1 is addressed by batching
 * graph expansion in get_context instead.
 */
export class EngineCache {
  private contextCache: Map<string, CachedContext>;
  private config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.contextCache = new Map();
  }

  // ─── Context Cache ───────────────────────────────────────

  getContext(key: string): string | null {
    const cached = this.contextCache.get(key);
    if (!cached) {
      metrics.cacheMisses.inc({ kind: 'context' });
      return null;
    }

    if (Date.now() - cached.cachedAt > this.config.contextTTLMs) {
      this.contextCache.delete(key);
      metrics.cacheMisses.inc({ kind: 'context' });
      return null;
    }

    metrics.cacheHits.inc({ kind: 'context' });
    return cached.result;
  }

  setContext(key: string, result: string, nodeIds: string[]): void {
    // LRU eviction
    if (this.contextCache.size >= this.config.contextCacheSize) {
      const oldestKey = this.contextCache.keys().next().value;
      if (oldestKey) this.contextCache.delete(oldestKey);
    }

    this.contextCache.set(key, {
      key,
      result,
      nodeIds: new Set(nodeIds),
      cachedAt: Date.now(),
    });
  }

  /** Drop any cached context that references this node. Called from the
   *  mutate/link/merge tool handlers so a stale recall can't survive a write. */
  invalidateNode(id: string): void {
    for (const [key, entry] of this.contextCache) {
      if (entry.nodeIds.has(id)) {
        this.contextCache.delete(key);
      }
    }
  }

  // ─── Utilities ───────────────────────────────────────────

  clear(): void {
    this.contextCache.clear();
  }

  get stats() {
    return {
      contextCount: this.contextCache.size,
    };
  }
}
