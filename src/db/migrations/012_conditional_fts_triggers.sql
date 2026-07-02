-- P7: cut FTS write amplification on the nodes hot path.
--
-- Two problems with the 007 trigger set, both measured on synthetic DBs:
--
-- (1) nodes_fts_au fired on EVERY nodes UPDATE. One fire (FTS delete +
--     re-tokenize + insert) costs ~0.65ms at 5k nodes while the underlying
--     metadata UPDATE costs ~0.01ms. Every mutate/link/merge back-fills
--     event_id right after the real write, so each mutation re-indexed the
--     SAME content twice; maintenance decay (confidence/last_decayed_at only)
--     re-indexed every stale node for zero index change.
--
-- (2) The triggers deleted by `WHERE id = OLD.id`, but `id` is an UNINDEXED
--     FTS5 column — that DELETE is a full scan of the FTS shadow table, so
--     every node update/delete paid O(active-nodes) just to find the row.
--
-- Fix: rebuild nodes_fts with rowid = nodes.rowid (FTS5 lets us assign
-- rowids explicitly), so triggers can delete by rowid — an O(log N) keyed
-- lookup. The AFTER UPDATE trigger also gains a WHEN guard so it only fires
-- when an FTS-indexed column actually changes (IS NOT handles NULL
-- summaries). Archived semantics unchanged: 0→1 removes the FTS row, 1→0
-- re-adds it.
--
-- NOTE: nothing in engram runs VACUUM (verified). If VACUUM is ever added,
-- it can renumber nodes.rowid (TEXT primary key ⇒ implicit rowid) and this
-- mapping must be rebuilt: DELETE FROM nodes_fts; re-run the INSERT..SELECT
-- below.

DROP TRIGGER IF EXISTS nodes_fts_ai;
DROP TRIGGER IF EXISTS nodes_fts_au;
DROP TRIGGER IF EXISTS nodes_fts_ad;

-- Re-key existing FTS rows to nodes.rowid (delete-all + reinsert is the only
-- way to change FTS rowids; the corpus is small enough that this one-time
-- rebuild is cheap: ~1ms/1k nodes).
DELETE FROM nodes_fts;
INSERT INTO nodes_fts (rowid, id, namespace, name, type, summary, properties)
SELECT rowid, id, namespace, name, type, COALESCE(summary, ''), properties
FROM nodes
WHERE archived = 0;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes
WHEN NEW.archived = 0
BEGIN
    INSERT INTO nodes_fts (rowid, id, namespace, name, type, summary, properties)
    VALUES (NEW.rowid, NEW.id, NEW.namespace, NEW.name, NEW.type, COALESCE(NEW.summary, ''), NEW.properties);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes
WHEN OLD.name IS NOT NEW.name
  OR OLD.type IS NOT NEW.type
  OR OLD.summary IS NOT NEW.summary
  OR OLD.properties IS NOT NEW.properties
  OR OLD.namespace IS NOT NEW.namespace
  OR OLD.archived IS NOT NEW.archived
BEGIN
    DELETE FROM nodes_fts WHERE rowid = OLD.rowid;
    INSERT INTO nodes_fts (rowid, id, namespace, name, type, summary, properties)
    SELECT NEW.rowid, NEW.id, NEW.namespace, NEW.name, NEW.type, COALESCE(NEW.summary, ''), NEW.properties
    WHERE NEW.archived = 0;
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes
BEGIN
    DELETE FROM nodes_fts WHERE rowid = OLD.rowid;
END;
