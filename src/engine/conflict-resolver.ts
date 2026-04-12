import type { Node } from '../types/index.js';
import type { StateTree } from '../db/state-tree.js';

export interface DuplicateCandidate {
  existing: Node;
  similarity: 'exact' | 'name_match';
}

/**
 * Check for potential duplicate nodes before creation.
 * Returns existing candidates that might conflict with the proposed new node.
 */
export function detectDuplicates(
  stateTree: StateTree,
  type: string,
  name: string,
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  // Exact name + type match
  const byName = stateTree.getNodeByName(name);
  if (byName && byName.type === type && !byName.archived) {
    candidates.push({ existing: byName, similarity: 'exact' });
    return candidates;
  }

  // Same name, different type — still flag it
  if (byName && !byName.archived) {
    candidates.push({ existing: byName, similarity: 'name_match' });
  }

  return candidates;
}

/**
 * Resolve a conflict by choosing the newer data (last-write-wins).
 * The version history in node_history preserves the full audit trail.
 */
export function resolveConflict(
  current: Node,
  incoming: Partial<Pick<Node, 'name' | 'summary' | 'confidence' | 'properties'>>,
): { merged: Record<string, unknown>; name: string; summary: string | null; confidence: number } {
  const mergedProps = { ...current.properties };

  if (incoming.properties) {
    Object.assign(mergedProps, incoming.properties);
  }

  return {
    merged: mergedProps,
    name: incoming.name ?? current.name,
    summary: incoming.summary ?? current.summary,
    confidence: incoming.confidence ?? current.confidence,
  };
}
