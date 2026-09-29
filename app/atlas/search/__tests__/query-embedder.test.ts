/**
 * SEARCH-19: the embedder seam. The browser embedder must return an L2-normalised
 * vector of the model's width; the low-memory path uses `/api/search/dense` instead
 * (see server-dense-backend.ts), so this is the only implementation.
 */
import { describe, expect, it, vi } from 'vitest';
import { QUERY_EMBEDDING_MODEL } from '../embedding-model';
import { LocalQueryEmbedder } from '../query-embedder';

function fakeVector(): Float32Array {
  const vector = new Float32Array(QUERY_EMBEDDING_MODEL.dims);
  for (let d = 0; d < vector.length; d += 1) vector[d] = Math.sin(d + 1);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  for (let d = 0; d < vector.length; d += 1) vector[d] /= norm;
  return vector;
}

vi.mock('../embedding-model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../embedding-model')>();
  return { ...original, embedQueryLocal: vi.fn(async () => fakeVector()) };
});

describe('LocalQueryEmbedder', () => {
  it(`returns an L2-normalised vector of ${QUERY_EMBEDDING_MODEL.dims} dims`, async () => {
    const vector = await new LocalQueryEmbedder().embed('collateral liquidation');
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(QUERY_EMBEDDING_MODEL.dims);
    let norm = 0;
    for (const value of vector) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 3);
  });
});
