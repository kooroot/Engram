import type Database from 'better-sqlite3';
import type { NodeRow } from '../types/index.js';

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
 * Run maintenance tasks on the state tree:
 * - Confidence decay for stale nodes
 * - Archive low-confidence / inactive nodes
 * - Detect orphan nodes (no edges, not rule/concept)
 */
export function runMaintenance(
  db: Database.Database,
  config: Partial<MaintenanceConfig> = {},
): MaintenanceReport {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const report: MaintenanceReport = {
    decayed: 0,
    archived: 0,
    orphansDetected: 0,
  };

  // M4: Proportional confidence decay based on elapsed days since last update
  // decay = factor ^ days_since_update (more stale = more decay)
  const decayStmt = db.prepare(`
    UPDATE nodes
    SET confidence = confidence * POWER(@factor,
      MAX(1, CAST(julianday('now') - julianday(updated_at) AS INTEGER))),
        updated_at = updated_at
    WHERE archived = 0
      AND updated_at < datetime('now', @daysAgo)
      AND confidence > @threshold
  `);

  const decayResult = decayStmt.run({
    factor: cfg.confidenceDecayFactor,
    daysAgo: `-${cfg.archiveInactiveDays} days`,
    threshold: cfg.archiveConfidenceThreshold,
  });
  report.decayed = decayResult.changes;

  // 2. Archive nodes with low confidence
  const archiveStmt = db.prepare(`
    UPDATE nodes
    SET archived = 1
    WHERE archived = 0
      AND confidence < @threshold
  `);

  const archiveResult = archiveStmt.run({
    threshold: cfg.archiveConfidenceThreshold,
  });
  report.archived = archiveResult.changes;

  // 3. Detect orphan nodes (no edges, not standalone types, old enough)
  const orphanStmt = db.prepare(`
    SELECT n.id FROM nodes n
    WHERE n.archived = 0
      AND n.type NOT IN ('rule', 'concept')
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id
      )
      AND n.updated_at < datetime('now', @daysAgo)
  `);

  const orphans = orphanStmt.all({
    daysAgo: `-${cfg.orphanGraceDays} days`,
  }) as Array<{ id: string }>;

  report.orphansDetected = orphans.length;

  // Archive orphans
  if (orphans.length > 0) {
    const archiveOrphanStmt = db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?');
    const archiveOrphans = db.transaction(() => {
      for (const orphan of orphans) {
        archiveOrphanStmt.run(orphan.id);
      }
    });
    archiveOrphans();
    report.archived += orphans.length;
  }

  return report;
}

/**
 * Get counts of active vs archived nodes.
 */
export function getStateStats(db: Database.Database): {
  activeNodes: number;
  archivedNodes: number;
  activeEdges: number;
  totalEvents: number;
} {
  const nodeStats = db.prepare(`
    SELECT
      SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived
    FROM nodes
  `).get() as { active: number; archived: number };

  const edgeCount = db.prepare(
    'SELECT COUNT(*) as count FROM edges WHERE archived = 0'
  ).get() as { count: number };

  const eventCount = db.prepare(
    'SELECT COUNT(*) as count FROM events'
  ).get() as { count: number };

  return {
    activeNodes: nodeStats.active ?? 0,
    archivedNodes: nodeStats.archived ?? 0,
    activeEdges: edgeCount.count,
    totalEvents: eventCount.count,
  };
}
