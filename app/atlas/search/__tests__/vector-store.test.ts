/**
 * SEARCH-19: the vector store — u8-dim encode/decode roundtrip, brute-force search, and
 * the loader's refuse-anything-suspect contract (a bad artifact disables the dense rung;
 * it never corrupts results or throws into the search path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corpusHash } from '../prebuilt-index';
import { VECTOR_STORE_VERSION, type VectorManifest, VectorStore, tryLoadVectorStore } from '../vector-store';

const DIMS = 64;
const COUNT = 50;

/** Deterministic pseudo-random unit vectors (LCG) — no flakiness, no model download. */
function testVectors(count = COUNT, dims = DIMS): Float32Array[] {
  let state = 42;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
  return Array.from({ length: count }, () => {
    const vector = new Float32Array(dims);
    for (let d = 0; d < dims; d += 1) vector[d] = next();
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d += 1) vector[d] /= norm;
    return vector;
  });
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let d = 0; d < a.length; d += 1) sum += a[d] * b[d];
  return sum;
}

const META = {
  corpusHash: 'a'.repeat(64),
  model: 'bge-small',
  docNos: Array.from({ length: COUNT }, (_, i) => `A.${i}`),
};

describe('VectorStore encode/decode', () => {
  it('roundtrips: layout sizes, manifest fields, and self-retrieval', () => {
    const vectors = testVectors();
    const { manifest, blob } = VectorStore.encode(vectors, META);

    expect(manifest.version).toBe(VECTOR_STORE_VERSION);
    expect(manifest.quantization).toBe('u8-dim');
    expect(manifest.dims).toBe(DIMS);
    expect(manifest.count).toBe(COUNT);
    expect(blob.byteLength).toBe(DIMS * 8 + COUNT * DIMS);

    const store = VectorStore.decode(manifest, blob);
    for (const row of [0, 7, COUNT - 1]) {
      const hits = store.search(vectors[row], 3);
      expect(hits[0].row).toBe(row); // a vector's nearest neighbour is itself
      expect(hits[0].docNo).toBe(`A.${row}`);
      expect(hits[0].score).toBeCloseTo(1, 1);
    }
  });

  it('keeps quantised scores close to the true dot product', () => {
    const vectors = testVectors();
    const { manifest, blob } = VectorStore.encode(vectors, META);
    const store = VectorStore.decode(manifest, blob);

    const hits = store.search(vectors[3], COUNT);
    for (const hit of hits) {
      expect(Math.abs(hit.score - dot(vectors[3], vectors[hit.row]))).toBeLessThan(0.02);
    }
  });

  it('refuses an empty vector set and a blob whose size disagrees with the manifest', () => {
    expect(() => VectorStore.encode([], META)).toThrow(/empty/);

    const { manifest, blob } = VectorStore.encode(testVectors(), META);
    expect(() => VectorStore.decode(manifest, blob.slice(0, blob.byteLength - 1))).toThrow(/bytes/);
  });

  it('rejects a query with the wrong dimension count', () => {
    const { manifest, blob } = VectorStore.encode(testVectors(), META);
    const store = VectorStore.decode(manifest, blob);
    expect(() => store.search(new Float32Array(DIMS + 1), 5)).toThrow(/dims/);
  });
});

describe('tryLoadVectorStore', () => {
  const scopeTrees = [{ doc_no: 'A.0', name: 'root' }];

  function stubFetch(manifest: unknown, blob?: ArrayBuffer): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path.endsWith('.json') ? new Response(JSON.stringify(manifest)) : new Response(blob ?? new ArrayBuffer(0)),
      ),
    );
  }

  async function artifactsFor(trees: unknown): Promise<{ manifest: VectorManifest; blob: ArrayBuffer }> {
    const hash = await corpusHash(trees);
    return VectorStore.encode(testVectors(), { ...META, corpusHash: hash! });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('loads a matching artifact and searches it', async () => {
    const { manifest, blob } = await artifactsFor(scopeTrees);
    stubFetch(manifest, blob);

    const store = await tryLoadVectorStore(scopeTrees);
    expect(store).not.toBeNull();
    expect(store!.search(testVectors()[0], 1)[0].row).toBe(0);
  });

  it('returns null on a corpus-hash mismatch', async () => {
    const { manifest, blob } = await artifactsFor([{ doc_no: 'B.0', name: 'other tree' }]);
    stubFetch(manifest, blob);
    expect(await tryLoadVectorStore(scopeTrees)).toBeNull();
  });

  it('returns null on a wrong version, a malformed manifest, or a fetch failure', async () => {
    const { manifest, blob } = await artifactsFor(scopeTrees);
    stubFetch({ ...manifest, version: 999 }, blob);
    expect(await tryLoadVectorStore(scopeTrees)).toBeNull();

    stubFetch({ hello: 'world' });
    expect(await tryLoadVectorStore(scopeTrees)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await tryLoadVectorStore(scopeTrees)).toBeNull();
  });

  it('returns null (not a corrupt store) when the blob does not match the manifest', async () => {
    const { manifest } = await artifactsFor(scopeTrees);
    stubFetch(manifest, new ArrayBuffer(16));
    expect(await tryLoadVectorStore(scopeTrees)).toBeNull();
  });
});
