/**
 * Pure heuristic duplicate-detection for Engram nodes. No DB, no I/O — just
 * name comparison. Callers (state-tree.mutate) wire this into the create path
 * so new nodes are auto-merged into matching existing ones.
 *
 * Tier 1 (always on, no embeddings needed):
 *   - Same type (strict gate — "bun" concept vs "bun" preference don't merge)
 *   - Normalized-name exact match (case/whitespace/unicode-form)
 *   - OR shorter normalized name is a substring of longer (min 3 chars to avoid "a" false-positives)
 *   - OR token Jaccard similarity ≥ 0.7
 *
 * TODO (Tier 2): semantic similarity via embeddings. When an embedding
 * provider is configured, extend isDedupCandidate with a vector-cosine
 * branch gated on same-type. Keep Tier 1 as the fast-path pre-filter so
 * we only pay embedding cost on ambiguous names.
 */

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().normalize('NFKC');
}

export function tokenize(name: string): Set<string> {
  return new Set(
    normalizeName(name)
      .split(/\s+/)
      .map(t => t.replace(/[^\p{L}\p{N}\-_]/gu, '')) // strip punctuation
      .filter(t => t.length >= 2) // drop single-char noise
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type MatchReason = 'exact' | 'substring' | 'jaccard';

export interface DedupMatch {
  reason: MatchReason;
  /** 0..1 — for substring/jaccard, the similarity score. Exact = 1. */
  score: number;
}

export interface DedupOptions {
  jaccardThreshold?: number;    // default 0.7
  substringMinLen?: number;     // default 3
}

/**
 * Returns match info if `incoming` should be treated as a duplicate of
 * `existing`, null otherwise. Type mismatch always → null (strict gate).
 */
export function isDedupCandidate(
  incoming: { name: string; type: string },
  existing: { name: string; type: string },
  opts: DedupOptions = {},
): DedupMatch | null {
  if (incoming.type !== existing.type) return null;

  const nIn = normalizeName(incoming.name);
  const nEx = normalizeName(existing.name);

  if (nIn === nEx) return { reason: 'exact', score: 1 };

  const minLen = opts.substringMinLen ?? 3;
  const [shorter, longer] = nIn.length <= nEx.length ? [nIn, nEx] : [nEx, nIn];
  if (shorter.length >= minLen && longer.includes(shorter)) {
    return { reason: 'substring', score: shorter.length / longer.length };
  }

  const threshold = opts.jaccardThreshold ?? 0.7;
  const tIn = tokenize(incoming.name);
  const tEx = tokenize(existing.name);
  const score = jaccard(tIn, tEx);
  if (score >= threshold) return { reason: 'jaccard', score };

  return null;
}
