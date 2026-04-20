/**
 * Retroactive dedup — scans existing active nodes for duplicates using the
 * same Tier 1 heuristic as the write-time auto-dedup (isDedupCandidate).
 * Phase 6b companion to Phase 6a; handles the back-catalog of duplicates
 * that already exist in the graph from before 6a landed (or from
 * concurrent writes that slipped through).
 *
 * Algorithm:
 *   - Bucket nodes by type (dedup is type-scoped).
 *   - Within each bucket, run pairwise isDedupCandidate.
 *   - Union matching pairs into connected components.
 *   - For each component of size ≥ 2, pick a canonical target and
 *     report all others as "sources" to merge into it.
 *
 * Target selection: highest confidence, tiebreaker earliest created_at.
 * This keeps the node most likely to be the "real" one and preserves
 * history order.
 *
 * Complexity: O(n²) per type bucket. Acceptable for typical engram sizes
 * (low thousands of nodes/type). For larger scales, swap in blocking /
 * LSH on normalized names — the isDedupCandidate signature is stable so
 * that's an additive change.
 */
import type Database from 'better-sqlite3';
import type { NodeRow } from '../types/index.js';
import { isDedupCandidate } from './dedup.js';

export interface DedupClusterSource {
  id: string;
  name: string;
  matched_by: 'exact' | 'substring' | 'jaccard';
  score: number;
}

export interface DedupCluster {
  type: string;
  target_id: string;
  target_name: string;
  sources: DedupClusterSource[];
}

/**
 * Find clusters of duplicates across all active nodes in the namespace.
 * Returns only clusters of size ≥ 2 (singletons aren't duplicates).
 */
export function findDedupClusters(
  db: Database.Database,
  namespace: string,
): DedupCluster[] {
  const rows = db.prepare(
    'SELECT id, type, name, confidence, created_at FROM nodes WHERE namespace = ? AND archived = 0'
  ).all(namespace) as Array<Pick<NodeRow, 'id' | 'type' | 'name' | 'confidence' | 'created_at'>>;

  // Bucket by type
  const byType = new Map<string, typeof rows>();
  for (const r of rows) {
    const bucket = byType.get(r.type);
    if (bucket) bucket.push(r);
    else byType.set(r.type, [r]);
  }

  const clusters: DedupCluster[] = [];

  for (const [type, bucket] of byType) {
    if (bucket.length < 2) continue;

    // Union-Find over this bucket
    const parent = new Map<string, string>();
    for (const r of bucket) parent.set(r.id, r.id);
    const find = (x: string): string => {
      let p = parent.get(x)!;
      while (p !== parent.get(p)) { p = parent.get(p)!; }
      parent.set(x, p); // path compression
      return p;
    };
    const union = (a: string, b: string) => {
      const pa = find(a), pb = find(b);
      if (pa !== pb) parent.set(pa, pb);
    };

    // Per-pair dedup scores so we can surface the highest-signal one per source
    const bestMatch = new Map<string, { other: string; match: { reason: 'exact' | 'substring' | 'jaccard'; score: number } }>();

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const m = isDedupCandidate(
          { name: a.name, type: a.type },
          { name: b.name, type: b.type },
        );
        if (m) {
          union(a.id, b.id);
          const bestA = bestMatch.get(a.id);
          if (!bestA || m.score > bestA.match.score) bestMatch.set(a.id, { other: b.id, match: m });
          const bestB = bestMatch.get(b.id);
          if (!bestB || m.score > bestB.match.score) bestMatch.set(b.id, { other: a.id, match: m });
        }
      }
    }

    // Group by root
    const groups = new Map<string, typeof bucket>();
    for (const r of bucket) {
      const root = find(r.id);
      const g = groups.get(root);
      if (g) g.push(r);
      else groups.set(root, [r]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      // Canonical target: max confidence, tiebreak earliest created_at
      const sortedForTarget = [...group].sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return (a.created_at ?? '').localeCompare(b.created_at ?? '');
      });
      const target = sortedForTarget[0]!;

      const sources: DedupClusterSource[] = group
        .filter(r => r.id !== target.id)
        .map(r => {
          const bm = bestMatch.get(r.id);
          return {
            id: r.id,
            name: r.name,
            matched_by: bm?.match.reason ?? 'jaccard',
            score: bm?.match.score ?? 0,
          };
        });

      clusters.push({
        type,
        target_id: target.id,
        target_name: target.name,
        sources,
      });
    }
  }

  return clusters;
}

export interface DedupPassReport {
  clusters: DedupCluster[];
  merged_count: number; // # source nodes merged into targets (not incl. targets themselves)
  merged_edges: number;
  dedup_edges: number;
  failed: Array<{ source_id: string; target_id: string; error: string }>;
}

/**
 * Find-and-merge. If `dryRun` is true, returns the cluster report
 * without performing any merges.
 */
export function runDedupPass(
  db: Database.Database,
  namespace: string,
  merge: (sourceId: string, targetId: string) => { merged_edges: number; dedup_edges: number },
  dryRun: boolean = false,
): DedupPassReport {
  const clusters = findDedupClusters(db, namespace);
  const report: DedupPassReport = {
    clusters,
    merged_count: 0,
    merged_edges: 0,
    dedup_edges: 0,
    failed: [],
  };
  if (dryRun) return report;

  for (const cluster of clusters) {
    for (const src of cluster.sources) {
      try {
        const res = merge(src.id, cluster.target_id);
        report.merged_count += 1;
        report.merged_edges += res.merged_edges;
        report.dedup_edges += res.dedup_edges;
      } catch (err) {
        report.failed.push({
          source_id: src.id,
          target_id: cluster.target_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return report;
}
