import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  tokenize,
  jaccard,
  isDedupCandidate,
} from '../../src/engine/dedup.js';

describe('dedup — normalizeName', () => {
  it('trims whitespace and lowercases', () => {
    expect(normalizeName('  Engram  ')).toBe('engram');
    expect(normalizeName('Engram Twin Mode')).toBe('engram twin mode');
  });

  it('applies NFKC unicode normalization', () => {
    // Full-width "Ｅ" (U+FF25) should normalize to "e"
    expect(normalizeName('\uFF25ngram')).toBe('engram');
  });
});

describe('dedup — tokenize', () => {
  it('splits on whitespace and drops single-char tokens', () => {
    expect([...tokenize('Use bun not npm')].sort()).toEqual(['bun', 'not', 'npm', 'use']);
  });

  it('strips punctuation but keeps hyphens and underscores', () => {
    expect([...tokenize('Hello, world!')].sort()).toEqual(['hello', 'world']);
    expect([...tokenize('auto-merge and under_score')].sort()).toEqual([
      'and', 'auto-merge', 'under_score',
    ]);
  });

  it('drops single-char noise', () => {
    // "a" should be dropped (length < 2)
    expect([...tokenize('a bb ccc')].sort()).toEqual(['bb', 'ccc']);
  });
});

describe('dedup — jaccard', () => {
  it('returns 0 for empty sets', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('computes partial overlap', () => {
    // {a,b} vs {b,c}: intersection=1, union=3 → 1/3
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 5);
  });
});

describe('dedup — isDedupCandidate', () => {
  it('returns null when types differ (strict gate)', () => {
    expect(isDedupCandidate(
      { name: 'bun', type: 'concept' },
      { name: 'bun', type: 'preference' },
    )).toBeNull();
  });

  it('returns exact match for identical names', () => {
    const m = isDedupCandidate(
      { name: 'Engram', type: 'project' },
      { name: 'Engram', type: 'project' },
    );
    expect(m?.reason).toBe('exact');
    expect(m?.score).toBe(1);
  });

  it('returns exact match ignoring case/whitespace', () => {
    const m = isDedupCandidate(
      { name: '  engram  ', type: 'project' },
      { name: 'Engram', type: 'project' },
    );
    expect(m?.reason).toBe('exact');
  });

  it('returns substring match when shorter fits in longer', () => {
    const m = isDedupCandidate(
      { name: 'Engram Twin Mode', type: 'project' },
      { name: 'engram', type: 'project' },
    );
    expect(m?.reason).toBe('substring');
    expect(m?.score).toBeGreaterThan(0);
    expect(m?.score).toBeLessThanOrEqual(1);
  });

  it('returns substring match (symmetric in direction)', () => {
    const m = isDedupCandidate(
      { name: 'Use bun', type: 'preference' },
      { name: 'Use bun not npm', type: 'preference' },
    );
    expect(m?.reason).toBe('substring');
  });

  it('returns jaccard match above threshold', () => {
    // "AI memory system" vs "AI memory" → tokens {ai,memory,system} vs {ai,memory}
    // intersection=2, union=3 → 2/3 ≈ 0.667 (below 0.7 default)
    // Use a pair that clears 0.7: {ai,memory,system} vs {ai,memory,system,big} → 3/4 = 0.75
    const m = isDedupCandidate(
      { name: 'AI memory system', type: 'concept' },
      { name: 'AI memory system big', type: 'concept' },
    );
    expect(m?.reason === 'jaccard' || m?.reason === 'substring').toBe(true);
  });

  it('returns null for unrelated names of same type', () => {
    expect(isDedupCandidate(
      { name: 'Cat', type: 'animal' },
      { name: 'Dog', type: 'animal' },
    )).toBeNull();
  });

  it('guards short substrings (single-char would false-positive)', () => {
    // "a" is length 1, below substringMinLen=3, so should NOT match
    expect(isDedupCandidate(
      { name: 'a', type: 'concept' },
      { name: 'abc', type: 'concept' },
    )).toBeNull();
  });

  it('respects jaccard threshold option', () => {
    // {a,b} vs {b,c}: jaccard = 1/3 ≈ 0.33, below default 0.7
    const defaultResult = isDedupCandidate(
      { name: 'aa bb', type: 't' },
      { name: 'bb cc', type: 't' },
    );
    expect(defaultResult).toBeNull();

    // Lower threshold to 0.3 → should match
    const lowered = isDedupCandidate(
      { name: 'aa bb', type: 't' },
      { name: 'bb cc', type: 't' },
      { jaccardThreshold: 0.3 },
    );
    expect(lowered?.reason).toBe('jaccard');
  });
});
