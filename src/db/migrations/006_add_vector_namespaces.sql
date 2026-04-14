-- Namespace scoping for vector embeddings
ALTER TABLE embeddings ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_embeddings_namespace ON embeddings(namespace);
CREATE INDEX IF NOT EXISTS idx_embeddings_ns_source ON embeddings(namespace, source_type, source_id);
