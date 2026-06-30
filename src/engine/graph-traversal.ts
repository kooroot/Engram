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

    for (const [nodeId, currentDepth] of queue) {
      if (currentDepth >= maxDepth) continue;

      const edges = getEdges(stateTree, nodeId, direction);
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

        if (!visitedNodes.has(neighborId)) {
          const neighbor = stateTree.getNode(neighborId);
          if (neighbor && (!neighbor.archived || params.includeArchived)) {
            visitedNodes.add(neighborId);
            collectedNodes.push(neighbor);
            nextQueue.push([neighborId, currentDepth + 1]);
            depthReached = Math.max(depthReached, currentDepth + 1);
          }
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
export function expandNeighborhood(
  stateTree: StateTree,
  anchorIds: string[],
): { nodes: Node[]; edges: Edge[] } {
  if (anchorIds.length === 0) return { nodes: [], edges: [] };

  const anchorSet = new Set(anchorIds);
  const edges = stateTree.getEdgesForNodes(anchorIds);

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

function getEdges(stateTree: StateTree, nodeId: string, direction: string): Edge[] {
  switch (direction) {
    case 'outgoing':
      return stateTree.getEdgesFrom(nodeId);
    case 'incoming':
      return stateTree.getEdgesTo(nodeId);
    case 'both':
    default: {
      const outgoing = stateTree.getEdgesFrom(nodeId);
      const incoming = stateTree.getEdgesTo(nodeId);
      // Deduplicate (an edge could appear in both if self-referencing)
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
