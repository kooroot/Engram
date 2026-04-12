import type { Node } from '../types/index.js';

export interface CacheConfig {
  maxNodes: number;
  nodeTTLMs: number;
  contextCacheSize: number;
  contextTTLMs: number;
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxNodes: 10_000,
  nodeTTLMs: 300_000,      // 5 minutes
  contextCacheSize: 100,
  contextTTLMs: 60_000,    // 1 minute
};

interface CachedNode {
  node: Node;
  cachedAt: number;
}

interface CachedContext {
  key: string;
  result: string;
  nodeIds: Set<string>;
  cachedAt: number;
}

/**
 * In-memory cache for hot nodes and context results.
 * Node cache: Map with TTL eviction.
 * Context cache: LRU with TTL and invalidation on mutation.
 */
export class EngineCache {
  private nodeCache: Map<string, CachedNode>;
  private contextCache: Map<string, CachedContext>;
  private config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.nodeCache = new Map();
    this.contextCache = new Map();
  }

  // ─── Node Cache ───────────────���─────────────────────────

  getNode(id: string): Node | null {
    const cached = this.nodeCache.get(id);
    if (!cached) return null;

    if (Date.now() - cached.cachedAt > this.config.nodeTTLMs) {
      this.nodeCache.delete(id);
      return null;
    }

    return cached.node;
  }

  setNode(node: Node): void {
    // Evict if at capacity
    if (this.nodeCache.size >= this.config.maxNodes) {
      this.evictOldestNodes(Math.floor(this.config.maxNodes * 0.1));
    }

    this.nodeCache.set(node.id, { node, cachedAt: Date.now() });
  }

  invalidateNode(id: string): void {
    this.nodeCache.delete(id);

    // Invalidate any context cache entries that reference this node
    for (const [key, entry] of this.contextCache) {
      if (entry.nodeIds.has(id)) {
        this.contextCache.delete(key);
      }
    }
  }

  // ─── Context Cache ───────────────────────────��──────────

  getContext(key: string): string | null {
    const cached = this.contextCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.cachedAt > this.config.contextTTLMs) {
      this.contextCache.delete(key);
      return null;
    }

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

  // ─── Utilities ──────────────────────────────��───────────

  clear(): void {
    this.nodeCache.clear();
    this.contextCache.clear();
  }

  get stats() {
    return {
      nodeCount: this.nodeCache.size,
      contextCount: this.contextCache.size,
    };
  }

  private evictOldestNodes(count: number): void {
    const entries = [...this.nodeCache.entries()]
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt);

    for (let i = 0; i < count && i < entries.length; i++) {
      this.nodeCache.delete(entries[i][0]);
    }
  }
}
