import type Database from 'better-sqlite3';

export interface MaintenanceConfig {
  confidenceDecayFactor: number;
  archiveConfidenceThreshold: number;
  archiveInactiveDays: number;
  orphanGraceDays: number;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  confidenceDecayFactor: 0.95,
  archiveConfidenceThreshold: 0.3,
  archiveInactiveDays: 90,
  orphanGraceDays: 30,
};

export interface MaintenanceReport {
  decayed: number;
  archived: number;
  orphansDetected: number;
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

  // M4: Proportional confidence decay
  const decayStmt = db.prepare(`
    UPDATE nodes
    SET confidence = confidence * POWER(@factor,
      MAX(1, CAST(julianday('now') - julianday(updated_at) AS INTEGER))),
        updated_at = updated_at
    WHERE namespace = @ns
      AND archived = 0
      AND updated_at < datetime('now', @daysAgo)
      AND confidence > @threshold
  `);

  const decayResult = decayStmt.run({
    ns: namespace,
    factor: cfg.confidenceDecayFactor,
    daysAgo: `-${cfg.archiveInactiveDays} days`,
    threshold: cfg.archiveConfidenceThreshold,
  });
  report.decayed = decayResult.changes;

  const archiveStmt = db.prepare(`
    UPDATE nodes
    SET archived = 1
    WHERE namespace = @ns
      AND archived = 0
      AND confidence < @threshold
  `);

  const archiveResult = archiveStmt.run({
    ns: namespace,
    threshold: cfg.archiveConfidenceThreshold,
  });
  report.archived = archiveResult.changes;

  const orphanStmt = db.prepare(`
    SELECT n.id FROM nodes n
    WHERE n.namespace = @ns
      AND n.archived = 0
      AND n.type NOT IN ('rule', 'concept')
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE (e.source_id = n.id OR e.target_id = n.id) AND e.namespace = @ns
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
