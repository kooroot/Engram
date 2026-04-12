CREATE TABLE IF NOT EXISTS node_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    properties  TEXT NOT NULL,
    changed_by  INTEGER,
    timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_node_history_node ON node_history(node_id, version);
