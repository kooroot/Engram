-- Namespace isolation: scope nodes/edges/events/history by namespace
-- Default 'default' for existing rows. All queries now filter by namespace.
ALTER TABLE nodes ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
ALTER TABLE edges ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
ALTER TABLE events ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
ALTER TABLE node_history ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace);
CREATE INDEX IF NOT EXISTS idx_edges_namespace ON edges(namespace);
CREATE INDEX IF NOT EXISTS idx_events_namespace ON events(namespace);
CREATE INDEX IF NOT EXISTS idx_node_history_namespace ON node_history(namespace);

-- Composite indexes for common scoped queries
CREATE INDEX IF NOT EXISTS idx_nodes_ns_type ON nodes(namespace, type) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_nodes_ns_name ON nodes(namespace, name) WHERE archived = 0;
