import { describe, expect, it } from 'vitest';
import { type CensusDocument, buildCensus, cosineFamilies } from '../census';

const LONG = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';

function doc(doc_no: string, content: string, name = 'Doc'): CensusDocument {
  return { doc_no, name, type: 'Core', breadcrumb: ['Parent'], content };
}

/** Unit vector along the given axis, with an optional small rotation toward the next axis. */
function vec(axis: number, lean = 0): Float32Array {
  const v = new Float32Array(8);
  v[axis] = Math.sqrt(1 - lean * lean);
  v[(axis + 1) % 8] = lean;
  return v;
}

describe('cosineFamilies', () => {
  it('groups near-parallel vectors and leaves distant ones alone', () => {
    const docs = [doc('A.1', LONG), doc('A.2', `${LONG} sixteen`), doc('B.1', LONG.toUpperCase())];
    // A.1 ↔ A.2 cosine ≈ 0.995 (lean 0.1); B.1 orthogonal.
    const { families, pairCounts } = cosineFamilies(docs, [vec(0), vec(0, 0.1), vec(4)], 0.98);
    expect(families).toHaveLength(1);
    expect(families[0].docNos).toEqual(['A.1', 'A.2']);
    expect(pairCounts['0.98']).toBe(1);
    expect(pairCounts['0.99']).toBe(1);
  });

  it('excludes short bodies even when their vectors are identical', () => {
    const docs = [doc('A.1', 'short body'), doc('A.2', 'short body')];
    const { families } = cosineFamilies(docs, [vec(0), vec(0)], 0.98);
    expect(families).toEqual([]);
  });

  it('respects the threshold', () => {
    // lean 0.3 → cosine ≈ 0.954: above 0.95, below 0.98.
    const docs = [doc('A.1', LONG), doc('A.2', `${LONG} extra`)];
    const { families, pairCounts } = cosineFamilies(docs, [vec(0), vec(0, 0.3)], 0.98);
    expect(families).toEqual([]);
    expect(pairCounts['0.95']).toBe(1);
    expect(pairCounts['0.98']).toBe(0);
  });

  it('feeds buildCensus and crossCheckFamily as definition 4', () => {
    const docs = [doc('A.1', LONG), doc('A.2', `${LONG} sixteen`)];
    const census = buildCensus(docs, { model: 'test-model', vectors: [vec(0), vec(0, 0.1)] });
    expect(census.embeddingCosine?.model).toBe('test-model');
    expect(census.embeddingCosine?.families[0].docNos).toEqual(['A.1', 'A.2']);
    // Without vectors the field is absent and nothing else changes.
    expect(buildCensus(docs).embeddingCosine).toBeUndefined();
  });
});
