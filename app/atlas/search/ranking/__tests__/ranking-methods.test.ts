import { describe, expect, it } from 'vitest';
import { maxPool, rankDocuments, rrfOverFragments, topKWeighted } from '../rollup';
import { rrfFuse } from '../rrf';

// Fragment hits: doc 1 has one strong clause; doc 2 has two medium clauses.
const HITS = [
  { docId: 1, score: 0.9 },
  { docId: 2, score: 0.7 },
  { docId: 2, score: 0.6 },
  { docId: 3, score: 0.5 },
  { docId: 1, score: 0.1 },
];

describe('rollup (SEARCH-40)', () => {
  it('maxPool scores each document as its best fragment', () => {
    const byDoc = maxPool(HITS);
    expect(byDoc.get(1)).toBeCloseTo(0.9);
    expect(byDoc.get(2)).toBeCloseTo(0.7);
    expect(byDoc.get(3)).toBeCloseTo(0.5);
  });

  it('topKWeighted rewards a second matching clause', () => {
    const byDoc = topKWeighted(HITS, 0.5);
    expect(byDoc.get(1)).toBeCloseTo(0.9 + 0.5 * 0.1);
    expect(byDoc.get(2)).toBeCloseTo(0.7 + 0.5 * 0.6); // two medium clauses now beat one strong+weak
    expect(byDoc.get(3)).toBeCloseTo(0.5); // single hit: no second-best term
    expect(() => topKWeighted(HITS, 1.5)).toThrow();
  });

  it('rrfOverFragments sums reciprocal global ranks per document', () => {
    const byDoc = rrfOverFragments(HITS, 60);
    // Global ranks: doc1@1, doc2@2, doc2@3, doc3@4, doc1@5.
    expect(byDoc.get(1)).toBeCloseTo(1 / 61 + 1 / 65);
    expect(byDoc.get(2)).toBeCloseTo(1 / 62 + 1 / 63);
    expect(byDoc.get(3)).toBeCloseTo(1 / 64);
  });

  it('rankDocuments orders by score then docId, deterministically', () => {
    const ranked = rankDocuments(
      new Map([
        [7, 0.5],
        [3, 0.5],
        [9, 0.9],
      ]),
    );
    expect(ranked.map((r) => r.docId)).toEqual([9, 3, 7]);
  });

  it('the three rollups can rank the same evidence differently — the measured question', () => {
    const max = rankDocuments(maxPool(HITS)).map((r) => r.docId);
    const weighted = rankDocuments(topKWeighted(HITS, 0.5)).map((r) => r.docId);
    expect(max[0]).toBe(1); // best single clause wins under max-pooling
    expect(weighted[0]).toBe(2); // two corroborating clauses win under top-k weighting
  });
});

describe('rrfFuse (SEARCH-40)', () => {
  it('fuses ranked lists by summed reciprocal ranks', () => {
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);
    const byId = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(byId.a).toBeCloseTo(1 / 61 + 1 / 62);
    expect(byId.b).toBeCloseTo(1 / 62 + 1 / 61);
    expect(byId.d).toBeCloseTo(1 / 63);
    // a and b tie on score; the tie chain resolves deterministically.
    expect(fused[0].id).toBe('a');
    expect(fused[1].id).toBe('b');
  });

  it('an item found by two mediocre routes outranks one found by a single route', () => {
    const fused = rrfFuse([
      ['solo', 'both', 'x'],
      ['y', 'both', 'z'],
    ]);
    expect(fused[0].id).toBe('both'); // consensus beats confidence — RRF's defining property
  });

  it('breaks ties by best single rank, then first list', () => {
    const fused = rrfFuse([['p'], ['q']]); // identical scores and best ranks
    expect(fused[0].id).toBe('p'); // earlier list wins
  });
});
