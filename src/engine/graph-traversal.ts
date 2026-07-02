import type { Node, Edge } from '../types/index.js';
import type { StateTree } from '../db/state-tree.js';

export interface TraversalParams {
  from: string;
  predicates?: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  depth: number;
  includeArchived?: boolean;
}

export interface TraversalResult {
  nodes: Node[];
  edges: Edge[];
  meta: {
    total_nodes: number;
    depth_reached: number;
  };
}

/**
 * BFS graph traversal from a starting node.
 * Supports depth limits, predicate filtering, direction control, and cycle detection.
 *
 * Batched per BFS level: one edge query + one node-hydration query per level
 * instead of 3 point queries per visited node (the former N+1 — ~40µs of
 * synchronous, event-loop-blocking work per node made a depth-5 sweep of a
 * dense component cost hundreds of ms). Iteration order within a level is
 * kept deterministic (queue order; per node: outgoing before incoming, edges
 * in id order) so the caller's post-hoc `limit` slice stays stable.
 */
export function traverseGraph(
  stateTree: StateTree,
  params: TraversalParams,
): TraversalResult {
  const { from, predicates, direction, depth } = params;
  const maxDepth = Math.min(Math.max(depth, 1), 5);

  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();
  const collectedNodes: Node[] = [];
  const collectedEdges: Edge[] = [];
  let depthReached = 0;

  // Start with the anchor node
  const startNode = stateTree.getNode(from) ?? stateTree.getNodeByName(from);
  if (!startNode) {
    return { nodes: [], edges: [], meta: { total_nodes: 0, depth_reached: 0 } };
  }

  visitedNodes.add(startNode.id);
  collectedNodes.push(startNode);

  // BFS queue: [nodeId, currentDepth]
  let queue: Array<[string, number]> = [[startNode.id, 0]];

  while (queue.length > 0) {
    const nextQueue: Array<[string, number]> = [];

    const levelIds = queue.filter(([, d]) => d < maxDepth).map(([id]) => id);
    if (levelIds.length === 0) break;

    // One batched fetch for the whole level, grouped per node. Sorted by edge
    // id (ULIDs ≈ creation order) for a deterministic per-node order.
    const levelEdges = stateTree.getEdgesForNodes(levelIds)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const bySource = new Map<string, Edge[]>();
    const byTarget = new Map<string, Edge[]>();
    for (const e of levelEdges) {
      const s = bySource.get(e.source_id);
      if (s) s.push(e); else bySource.set(e.source_id, [e]);
      const t = byTarget.get(e.target_id);
      if (t) t.push(e); else byTarget.set(e.target_id, [e]);
    }

    // Pass 1 — walk edges in deterministic order, collect neighbor ids to
    // hydrate (batched below) while recording edge visits.
    const pendingNeighbors: Array<{ id: string; depth: number }> = [];
    const pendingSeen = new Set<string>();

    for (const [nodeId, currentDepth] of queue) {
      if (currentDepth >= maxDepth) continue;

      const edges = edgesForNode(nodeId, direction, bySource, byTarget);
      const filtered = predicates
        ? edges.filter(e => predicates.includes(e.predicate))
        : edges;

      for (const edge of filtered) {
        if (edge.archived && !params.includeArchived) continue;
        if (visitedEdges.has(edge.id)) continue;

        visitedEdges.add(edge.id);
        collectedEdges.push(edge);

        // Determine the neighbor node
        const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;

        if (!visitedNodes.has(neighborId) && !pendingSeen.has(neighborId)) {
          pendingSeen.add(neighborId);
          pendingNeighbors.push({ id: neighborId, depth: currentDepth + 1 });
        }
      }
    }

    // Pass 2 — hydrate all newly-encountered neighbors in one query, then
    // admit them in encounter order (matches the former per-edge getNode).
    if (pendingNeighbors.length > 0) {
      const hydrated = new Map<string, Node>();
      for (const n of stateTree.getNodesByIds(pendingNeighbors.map(p => p.id), true)) {
        hydrated.set(n.id, n);
      }
      for (const p of pendingNeighbors) {
        const neighbor = hydrated.get(p.id);
        if (neighbor && (!neighbor.archived || params.includeArchived)) {
          visitedNodes.add(p.id);
          collectedNodes.push(neighbor);
          nextQueue.push([p.id, p.depth]);
          depthReached = Math.max(depthReached, p.depth);
        }
      }
    }

    queue = nextQueue;
  }

  return {
    nodes: collectedNodes,
    edges: collectedEdges,
    meta: {
      total_nodes: collectedNodes.length,
      depth_reached: depthReached,
    },
  };
}

/**
 * Batched depth-1 neighborhood expansion for a SET of anchor nodes.
 *
 * Equivalent to running traverseGraph({ depth: 1, direction: 'both' }) from
 * each anchor and unioning the results, but in 2 queries total instead of
 * O(anchors) per-anchor traversals. The get_context read path (the hottest
 * path, hit on every SessionStart / UserPromptSubmit) previously expanded
 * every candidate individually — up to ~100 traversals, each re-fetching the
 * anchor and re-SELECTing hub neighbors shared with other candidates. This
 * collapses that to one edge query + one node query and dedups shared
 * neighbors for free.
 *
 * Returns every active edge touching an anchor, plus the active neighbor nodes
 * (excluding the anchors themselves). Matches traverseGraph's archived
 * handling: a non-archived edge to an archived neighbor is still returned, but
 * the archived neighbor node is not — buildContext then renders it by id, same
 * as before.
 */
/** Fetch cap per (anchor, direction) for context expansion. buildContext
 *  renders at most 8 edges per direction (MAX_EDGES_PER_DIRECTION) using the
 *  same confidence-then-recency order this cap keeps, so a hub anchor's
 *  rendered block is unchanged — but a 5k-edge hub no longer hydrates 5k edge
 *  rows + 5k neighbor nodes per get_context call. The only visible delta is
 *  the "(+N more)" tail, which now saturates at (cap − 8). */
export const EXPAND_EDGES_PER_ANCHOR_DIRECTION = 24;

export function expandNeighborhood(
  stateTree: StateTree,
  anchorIds: string[],
): { nodes: Node[]; edges: Edge[] } {
  if (anchorIds.length === 0) return { nodes: [], edges: [] };

  const anchorSet = new Set(anchorIds);
  const edges = stateTree.getEdgesForNodes(anchorIds, EXPAND_EDGES_PER_ANCHOR_DIRECTION);

  const neighborIds = new Set<string>();
  for (const e of edges) {
    if (!anchorSet.has(e.source_id)) neighborIds.add(e.source_id);
    if (!anchorSet.has(e.target_id)) neighborIds.add(e.target_id);
  }

  const nodes = neighborIds.size > 0
    ? stateTree.getNodesByIds([...neighborIds])
    : [];

  return { nodes, edges };
}

/** Per-node edge selection from the level's grouped fetch. Preserves the
 *  former per-node ordering contract: outgoing first, then incoming, deduped
 *  (a self-loop appears in both groups). */
function edgesForNode(
  nodeId: string,
  direction: string,
  bySource: Map<string, Edge[]>,
  byTarget: Map<string, Edge[]>,
): Edge[] {
  switch (direction) {
    case 'outgoing':
      return bySource.get(nodeId) ?? [];
    case 'incoming':
      return byTarget.get(nodeId) ?? [];
    case 'both':
    default: {
      const outgoing = bySource.get(nodeId) ?? [];
      const incoming = byTarget.get(nodeId) ?? [];
      const seen = new Set<string>();
      const all: Edge[] = [];
      for (const e of [...outgoing, ...incoming]) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          all.push(e);
        }
      }
      return all;
    }
  }
}
