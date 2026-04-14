-- Fix C-A2: Edge triplet uniqueness must be per-namespace, not global.
-- Same triplet (subject, predicate, object) can legitimately exist in
-- different namespaces without collision.

DROP INDEX IF EXISTS idx_edges_triplet;
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triplet
    ON edges(source_id, predicate, target_id, namespace);

-- Fix H-A4: Remove ON DELETE CASCADE on node_history so the audit trail
-- survives node deletion (matches the "immutable history" promise).
-- SQLite cannot drop a FK constraint in place; rebuild the table.
CREATE TABLE node_history_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     TEXT NOT NULL,
    version     INTEGER NOT NULL,
    properties  TEXT NOT NULL,
    changed_by  INTEGER,
    timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    namespace   TEXT NOT NULL DEFAULT 'default'
);

INSERT INTO node_history_new (id, node_id, version, properties, changed_by, timestamp, namespace)
SELECT id, node_id, version, properties, changed_by, timestamp, namespace FROM node_history;

DROP TABLE node_history;
ALTER TABLE node_history_new RENAME TO node_history;

CREATE INDEX IF NOT EXISTS idx_node_history_node ON node_history(node_id, version);
CREATE INDEX IF NOT EXISTS idx_node_history_namespace ON node_history(namespace);
