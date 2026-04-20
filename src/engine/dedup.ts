/**
 * Pure heuristic duplicate-detection for Engram nodes. No DB, no I/O — just
 * name comparison. Callers (state-tree.mutate) wire this into the create path
 * so new nodes are auto-merged into matching existing ones.
 *
 * Tier 1 (always on, no embeddings needed):
 *   - Same type (strict gate — "bun" concept vs "bun" preference don't merge)
 *   - Normalized-name exact match (case/whitespace/unicode-form)
 *   - OR shorter name's TOKENS are fully contained in longer's token set
 *     (e.g. "engram" ⊂ "Engram Twin Mode" ✓, but "Bot" ⊄ "Robotics" — token
 *      match, not raw substring, so "bot" inside "robotics" doesn't merge)
 *   - OR token Jaccard similarity ≥ 0.7
 *
 * Unicode note: normalization runs `trim → toLowerCase → NFKC`. Turkish
 * dotted `İ` (U+0130) lowercases to `i\u0307` (i + combining dot) under
 * default locale, which NFKC preserves, so it won't match plain `i`. This
 * is acceptable for English-dominant project names; extend with
 * locale-aware folding when that becomes a real concern.
 *
 * TODO (Tier 2): semantic similarity via embeddings. When an embedding
 * provider is configured, extend isDedupCandidate with a vector-cosine
 * branch gated on same-type. Keep Tier 1 as the fast-path pre-filter so
 * we only pay embedding cost on ambiguous names. The call site in
 * state-tree.ts will need a pluggable matcher interface then — current
 * signature is intentionally narrow so Tier 2 wiring is additive.
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

/** True when every element of `sub` appears in `sup`. */
function isSubset<T>(sub: Set<T>, sup: Set<T>): boolean {
  if (sub.size === 0) return false; // empty ⊆ anything is vacuously true but useless here
  for (const x of sub) if (!sup.has(x)) return false;
  return true;
}

export type MatchReason = 'exact' | 'substring' | 'jaccard';

export interface DedupMatch {
  reason: MatchReason;
  /** 0..1 — for substring/jaccard, the similarity score. Exact = 1. */
  score: number;
}

export interface DedupOptions {
  jaccardThreshold?: number;    // default 0.7
}

/**
 * Returns match info if `incoming` should be treated as a duplicate of
 * `existing`, null otherwise. Type mismatch always → null (strict gate).
 *
 * "substring" reason now uses TOKEN-SUBSET containment, not raw substring —
 * avoids false positives like "Bot" merging into "Robotics" (where `bot`
 * appears inside `robotics` as a byte sequence but they're unrelated words).
 * "engram" still merges into "Engram Twin Mode" because `{engram}` ⊆
 * `{engram, twin, mode}` at the token level.
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

  const tIn = tokenize(incoming.name);
  const tEx = tokenize(existing.name);

  // Token-subset: shorter's tokens all present in longer's tokens.
  const [shorter, longer] = tIn.size <= tEx.size ? [tIn, tEx] : [tEx, tIn];
  if (isSubset(shorter, longer)) {
    return { reason: 'substring', score: shorter.size / longer.size };
  }

  const threshold = opts.jaccardThreshold ?? 0.7;
  const score = jaccard(tIn, tEx);
  if (score >= threshold) return { reason: 'jaccard', score };

  return null;
}
