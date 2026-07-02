import type Database from 'better-sqlite3';

export interface MaintenanceConfig {
  confidenceDecayFactor: number;
  archiveConfidenceThreshold: number;
  archiveInactiveDays: number;
  /** Min days a node must sit untouched (by updated_at) before low-confidence
   *  archiving applies. Protects freshly-created low-confidence nodes (an agent
   *  may deliberately log an uncertain fact below the threshold) from being
   *  archived on the very next maintenance cycle, before they can be reinforced
   *  or referenced. Distinct from archiveInactiveDays (the decay window). */
  archiveGraceDays: number;
  orphanGraceDays: number;
  /** Per-node cap on retained node_history snapshots (newest N + original v1). 0 disables pruning. */
  historyKeepVersions: number;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  confidenceDecayFactor: 0.95,
  archiveConfidenceThreshold: 0.3,
  archiveInactiveDays: 90,
  archiveGraceDays: 7,
  orphanGraceDays: 30,
  historyKeepVersions: 20,
};

export interface MaintenanceReport {
  decayed: number;
  archived: number;
  orphansDetected: number;
}

/**
 * Per-node history-pruning DELETE, shared by the write-time cap (StateTree)
 * and the retroactive compaction pass (runHistoryCompaction) so their semantics
 * can never drift. Keeps the newest @keepN snapshots (by version) for one node
 * PLUS its original (MIN(version), i.e. v1). Bind params: @node_id, @ns, @keepN.
 * Call sites must skip execution when @keepN <= 0.
 */
export const HISTORY_PRUNE_SQL = `
  DELETE FROM node_history INDEXED BY idx_node_history_node
  WHERE node_id = @node_id AND namespace = @ns
    AND id NOT IN (
      SELECT id FROM node_history
      WHERE node_id = @node_id AND namespace = @ns
      ORDER BY version DESC LIMIT @keepN
    )
    AND version <> (
      SELECT MIN(version) FROM node_history
      WHERE node_id = @node_id AND namespace = @ns
    )
`;
// ^ INDEXED BY pins the outer DELETE to the (node_id, version) index. Without
// stats (a DB that has never been ANALYZEd) the planner was observed picking
// idx_node_history_namespace — a scan of the ENTIRE namespace's history on
// every update/delete/auto-merge. The subqueries already resolve via the same
// index; this makes the whole prune O(log H + keepN) deterministically.

/** Sentinel thrown to roll back the dry-run transaction (identity-checked). */
const DRY_RUN_ABORT = new Error('history-compaction dry-run rollback');

/**
 * Retroactively compact node_history across a namespace: prune every node's
 * snapshots to keep-last-N + original v1. Use to one-shot already-bloated nodes
 * (the write-time cap only bounds NEW snapshots). Non-destructive to current
 * state — node_history is audit/display only. Runs in a single transaction.
 * When `dryRun` is true, performs the prune in a transaction that is rolled back,
 * so the returned count reflects what WOULD be removed without persisting it.
 */
export function runHistoryCompaction(
  db: Database.Database,
  namespace: string = 'default',
  keepVersions: number,
  dryRun: boolean = false,
): { historyPruned: number } {
  if (keepVersions <= 0) return { historyPruned: 0 };

  // Pre-filter to nodes that can actually have prunable snapshots. A node with
  // <= keepVersions+1 snapshots deletes nothing: HISTORY_PRUNE_SQL keeps the
  // newest keepVersions rows and additionally protects MIN(version), so for
  // keepVersions+1 rows the single non-kept row IS the min and is protected ->
  // a guaranteed no-op DELETE. Skipping those (HAVING COUNT(*) > keepVersions+1)
  // leaves historyPruned and the resulting history byte-identical while avoiding
  // one correlated-subquery DELETE per under-cap node — the steady-state shape,
  // since the write-time cap settles every mutated node at exactly keepN+1.
  const nodeIds = db
    .prepare(
      'SELECT node_id FROM node_history WHERE namespace = ? GROUP BY node_id HAVING COUNT(*) > ?'
    )
    .all(namespace, keepVersions + 1) as Array<{ node_id: string }>;

  const pruneStmt = db.prepare(HISTORY_PRUNE_SQL);
  let historyPruned = 0;
  const txn = db.transaction(() => {
    for (const { node_id } of nodeIds) {
      const res = pruneStmt.run({ node_id, ns: namespace, keepN: keepVersions });
      historyPruned += res.changes;
    }
    if (dryRun) throw DRY_RUN_ABORT; // roll back — count only
  });
  try {
    txn();
  } catch (err) {
    if (err !== DRY_RUN_ABORT) throw err;
  }
  return { historyPruned };
}

/**
 * Run maintenance tasks on the state tree (scoped to a namespace):
 * - Confidence decay for stale nodes
 * - Archive low-confidence / inactive nodes
 * - Detect orphan nodes (no edges, not rule/concept)
 */
export function runMaintenance(
  db: Database.Database,
  namespace: string = 'default',
  config: Partial<MaintenanceConfig> = {},
): MaintenanceReport {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const report: MaintenanceReport = { decayed: 0, archived: 0, orphansDetected: 0 };

  // M4 + P5: Proportional, IDEMPOTENT confidence decay.
  //
  // The decay anchor is the LATER of updated_at and last_decayed_at, so decay is
  // applied at most once per elapsed day and is safe to re-run:
  //   - exponent = whole days since that anchor; SET advances last_decayed_at to
  //     now(), so a second run the same day sees exponent 0 (the `>= 1` gate
  //     below makes it a true no-op) instead of re-applying the full inactivity
  //     exponent (the prior bug: factor^(now-updated_at) every run = N-fold decay).
  //   - MAX(updated_at, last_decayed_at) means a real mutation (which advances
  //     updated_at) implicitly resets the decay clock without the write path
  //     touching last_decayed_at — so no StateTree change is needed and the guard
  //     is self-correcting even for archive/merge/import paths.
  //   - IFNULL(last_decayed_at, updated_at) handles NULL (existing rows pre-011,
  //     freshly-created nodes, imported nodes): they anchor to updated_at, exactly
  //     as the original code did, then get a real last_decayed_at on first decay.
  // updated_at is intentionally NOT advanced here — it is load-bearing for the
  // archive/orphan inactivity windows (below) and read-path recency ordering.
  const decayStmt = db.prepare(`
    UPDATE nodes
    SET confidence = confidence * POWER(@factor,
          CAST(julianday('now')
               - MAX(julianday(updated_at), julianday(IFNULL(last_decayed_at, updated_at)))
               AS INTEGER)),
        last_decayed_at = strftime('%Y-%m-%dT%H:%M:%f','now')
    WHERE namespace = @ns
      AND archived = 0
      AND updated_at < datetime('now', @daysAgo)
      AND CAST(julianday('now')
               - MAX(julianday(updated_at), julianday(IFNULL(last_decayed_at, updated_at)))
               AS INTEGER) >= 1
      AND confidence > @threshold
  `);

  const decayResult = decayStmt.run({
    ns: namespace,
    factor: cfg.confidenceDecayFactor,
    daysAgo: `-${cfg.archiveInactiveDays} days`,
    threshold: cfg.archiveConfidenceThreshold,
  });
  report.decayed = decayResult.changes;

  // Archive low-confidence nodes — but only those that have also been inactive
  // for archiveGraceDays. Without the age gate, a node created (or updated) with
  // an explicitly low confidence (an agent logging an uncertain fact below the
  // threshold) was archived on the very next maintenance cycle — possibly the
  // same day, since the SessionStart hook can trigger one — vanishing from
  // get_context before it could be reinforced or referenced. The grace window
  // lets a fresh uncertain fact survive; a real update bumps updated_at and
  // resets the clock. Decay-driven archival is unaffected: decay only fires
  // after archiveInactiveDays (>> archiveGraceDays) of inactivity, so a node
  // decayed below the threshold is already well past the grace window.
  const archiveStmt = db.prepare(`
    UPDATE nodes
    SET archived = 1
    WHERE namespace = @ns
      AND archived = 0
      AND confidence < @threshold
      AND updated_at < datetime('now', @graceAgo)
  `);

  const archiveResult = archiveStmt.run({
    ns: namespace,
    threshold: cfg.archiveConfidenceThreshold,
    graceAgo: `-${cfg.archiveGraceDays} days`,
  });
  report.archived = archiveResult.changes;

  // Two anti-joins instead of one NOT EXISTS with an OR: the OR form can't
  // use either edge index (SQLite falls back to a full edge scan PER candidate
  // node — O(nodes × edges)); split, each subquery is a keyed probe on
  // idx_edges_source / idx_edges_target. Semantically identical:
  // NOT EXISTS(A OR B) ≡ NOT EXISTS(A) AND NOT EXISTS(B).
  const orphanStmt = db.prepare(`
    SELECT n.id FROM nodes n
    WHERE n.namespace = @ns
      AND n.archived = 0
      AND n.type NOT IN ('rule', 'concept')
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = n.id AND e.namespace = @ns
      )
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.namespace = @ns
      )
      AND n.updated_at < datetime('now', @daysAgo)
  `);

  const orphans = orphanStmt.all({
    ns: namespace,
    daysAgo: `-${cfg.orphanGraceDays} days`,
  }) as Array<{ id: string }>;

  report.orphansDetected = orphans.length;

  if (orphans.length > 0) {
    const archiveOrphanStmt = db.prepare(
      'UPDATE nodes SET archived = 1 WHERE id = ? AND namespace = ?'
    );
    const archiveOrphans = db.transaction(() => {
      for (const orphan of orphans) {
        archiveOrphanStmt.run(orphan.id, namespace);
      }
    });
    archiveOrphans();
    report.archived += orphans.length;
  }

  return report;
}

/** Get counts of active vs archived nodes (scoped to namespace) */
export function getStateStats(
  db: Database.Database,
  namespace: string = 'default',
): {
  activeNodes: number;
  archivedNodes: number;
  activeEdges: number;
  totalEvents: number;
} {
  const nodeStats = db.prepare(`
    SELECT
      SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived
    FROM nodes WHERE namespace = ?
  `).get(namespace) as { active: number | null; archived: number | null };

  const edgeCount = db.prepare(
    'SELECT COUNT(*) as count FROM edges WHERE namespace = ? AND archived = 0'
  ).get(namespace) as { count: number };

  const eventCount = db.prepare(
    'SELECT COUNT(*) as count FROM events WHERE namespace = ?'
  ).get(namespace) as { count: number };

  return {
    activeNodes: nodeStats.active ?? 0,
    archivedNodes: nodeStats.archived ?? 0,
    activeEdges: edgeCount.count,
    totalEvents: eventCount.count,
  };
}
