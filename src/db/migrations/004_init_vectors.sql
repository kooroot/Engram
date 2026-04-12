CREATE TABLE IF NOT EXISTS embeddings (
    id          TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK(source_type IN ('node','event','edge_context')),
    source_id   TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
