/**
 * Lightweight Prometheus-compatible metrics registry.
 * No external dependencies — text format output matches Prometheus exposition spec.
 */

type LabelValues = Record<string, string>;

interface CounterEntry { labels: LabelValues; value: number }
interface HistogramEntry { labels: LabelValues; buckets: Map<number, number>; sum: number; count: number }

function labelsKey(labels: LabelValues): string {
  const sorted = Object.keys(labels).sort();
  return sorted.map(k => `${k}=${labels[k]}`).join(',');
}

function formatLabels(labels: LabelValues): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}';
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Counter {
  private entries = new Map<string, CounterEntry>();
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  inc(labels: LabelValues = {}, by: number = 1): void {
    const key = labelsKey(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.entries.set(key, { labels, value: by });
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.entries.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const e of this.entries.values()) {
        lines.push(`${this.name}${formatLabels(e.labels)} ${e.value}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  private entries = new Map<string, CounterEntry>();
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  set(labels: LabelValues, value: number): void {
    const key = labelsKey(labels);
    this.entries.set(key, { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.entries.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const e of this.entries.values()) {
        lines.push(`${this.name}${formatLabels(e.labels)} ${e.value}`);
      }
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

class Histogram {
  private entries = new Map<string, HistogramEntry>();
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {}

  observe(labels: LabelValues, valueSeconds: number): void {
    const key = labelsKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { labels, buckets: new Map(this.buckets.map(b => [b, 0])), sum: 0, count: 0 };
      this.entries.set(key, entry);
    }
    entry.count++;
    entry.sum += valueSeconds;
    for (const b of this.buckets) {
      if (valueSeconds <= b) {
        entry.buckets.set(b, (entry.buckets.get(b) ?? 0) + 1);
      }
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    if (this.entries.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
    } else {
      for (const e of this.entries.values()) {
        const baseLabels = formatLabels(e.labels);
        for (const b of this.buckets) {
          const withLe = { ...e.labels, le: String(b) };
          lines.push(`${this.name}_bucket${formatLabels(withLe)} ${e.buckets.get(b) ?? 0}`);
        }
        lines.push(`${this.name}_bucket${formatLabels({ ...e.labels, le: '+Inf' })} ${e.count}`);
        lines.push(`${this.name}_count${baseLabels} ${e.count}`);
        lines.push(`${this.name}_sum${baseLabels} ${e.sum}`);
      }
    }
    return lines.join('\n');
  }
}

// ─── Registry ────────────────────────────────────────────

export const metrics = {
  // Counters
  mutations: new Counter(
    'engram_mutations_total',
    'Total node/edge mutations applied'
  ),
  queries: new Counter(
    'engram_queries_total',
    'Total read queries executed'
  ),
  contextRequests: new Counter(
    'engram_context_requests_total',
    'Total get_context calls'
  ),
  cacheHits: new Counter(
    'engram_cache_hits_total',
    'Cache hits (context or node)'
  ),
  cacheMisses: new Counter(
    'engram_cache_misses_total',
    'Cache misses (context or node)'
  ),
  embeddings: new Counter(
    'engram_embeddings_total',
    'Total embeddings generated'
  ),
  embeddingFailures: new Counter(
    'engram_embedding_failures_total',
    'Failed embedding generation attempts'
  ),
  apiRequests: new Counter(
    'engram_api_requests_total',
    'Total REST API requests'
  ),
  apiErrors: new Counter(
    'engram_api_errors_total',
    'REST API error responses (4xx, 5xx)'
  ),

  // Gauges
  activeNodes: new Gauge(
    'engram_active_nodes',
    'Active (non-archived) nodes per namespace'
  ),
  activeEdges: new Gauge(
    'engram_active_edges',
    'Active edges per namespace'
  ),

  // Histograms
  mutationDuration: new Histogram(
    'engram_mutation_duration_seconds',
    'Time to apply a mutation batch'
  ),
  queryDuration: new Histogram(
    'engram_query_duration_seconds',
    'Time to execute a read query'
  ),
  contextDuration: new Histogram(
    'engram_context_duration_seconds',
    'Time to build context (get_context)'
  ),
  apiDuration: new Histogram(
    'engram_api_duration_seconds',
    'REST API request duration'
  ),
};

export function renderMetrics(): string {
  const parts: string[] = [];
  for (const m of Object.values(metrics)) {
    parts.push(m.render());
  }
  return parts.join('\n\n') + '\n';
}

// ─── Timer helper ────────────────────────────────────────

export function startTimer(): () => number {
  const t0 = performance.now();
  return () => (performance.now() - t0) / 1000; // seconds
}
