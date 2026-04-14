-- FTS5 virtual table for fast keyword search over nodes
-- Indexes name, type, summary, and properties (as text) with namespace filter
-- Content is linked to nodes table via UNINDEXED id/namespace for joins
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id UNINDEXED,
    namespace UNINDEXED,
    name,
    type,
    summary,
    properties,
    tokenize = 'porter unicode61 remove_diacritics 1'
);

-- Backfill from existing nodes (safe on empty tables too)
INSERT INTO nodes_fts (id, namespace, name, type, summary, properties)
SELECT id, namespace, name, type, COALESCE(summary, ''), properties
FROM nodes
WHERE archived = 0;

-- Triggers keep FTS5 in sync with nodes
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes
WHEN NEW.archived = 0
BEGIN
    INSERT INTO nodes_fts (id, namespace, name, type, summary, properties)
    VALUES (NEW.id, NEW.namespace, NEW.name, NEW.type, COALESCE(NEW.summary, ''), NEW.properties);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes
BEGIN
    DELETE FROM nodes_fts WHERE id = OLD.id;
    INSERT INTO nodes_fts (id, namespace, name, type, summary, properties)
    SELECT NEW.id, NEW.namespace, NEW.name, NEW.type, COALESCE(NEW.summary, ''), NEW.properties
    WHERE NEW.archived = 0;
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes
BEGIN
    DELETE FROM nodes_fts WHERE id = OLD.id;
END;
