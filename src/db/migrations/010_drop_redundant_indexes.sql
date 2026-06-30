-- P3 schema cleanup: drop indexes that no query uses as its best access path.
--
-- Every node lookup is namespace-scoped, and every type/name query also filters
-- archived = 0 (see state-tree.ts) — so idx_nodes_ns_type / idx_nodes_ns_name
-- (composite, leading-namespace, partial WHERE archived = 0) already cover them.
-- No query filters nodes by type alone, by name alone, or by archived alone:
--   * idx_nodes_type / idx_nodes_name  -> superseded by the ns_* composites
--   * idx_nodes_active (archived) WHERE archived = 0 -> a constant-valued
--     partial index; no query filters on archived without a more selective
--     leading column, so the planner never prefers it.
-- Edge predicate filtering happens in JS during traversal, and the
-- subject+predicate+object lookup is served by the UNIQUE idx_edges_triplet, so
-- idx_edges_predicate has no leading-predicate query to accelerate.
--
-- Dropping these cuts write amplification (fewer b-trees to maintain on every
-- node/edge insert + update) and shrinks the DB, with no read-path regression
-- (verified via EXPLAIN QUERY PLAN against the live DB: the workhorse queries
-- still resolve through the ns_* composites, idx_edges_source/target, and
-- idx_edges_triplet).

DROP INDEX IF EXISTS idx_nodes_type;
DROP INDEX IF EXISTS idx_nodes_name;
DROP INDEX IF EXISTS idx_nodes_active;
DROP INDEX IF EXISTS idx_edges_predicate;
