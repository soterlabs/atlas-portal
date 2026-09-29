/**
 * Prebuilt document vectors for the dense rung (SEARCH-19).
 *
 * The build writes two artifacts:
 *  - `atlas-search-vectors.json` — the manifest: format version, corpus hash, model,
 *    dimensions, and the row → `doc_no` mapping. Small; fetched and verified first.
 *  - `atlas-search-vectors.bin` — per-dimension affine uint8 quantisation (u8-dim,
 *    chosen by the SEARCH-19 measurement: −0.0013 nDCG@10 vs float32 at ¼ the payload):
 *    `[min: f32 × dims][step: f32 × dims][data: u8 × count × dims]`, little-endian.
 *
 * Like the prebuilt index (SEARCH-17), the artifact is used only when its corpus hash
 * matches the tree the page holds — rows are array positions into the flattened
 * documents, and a mismatched blob would silently point at the wrong documents. Any
 * mismatch or failure returns null: the dense rung is skipped, the keyword tiers carry
 * the search (graceful degradation).
 *
 * Scoring dequantises on the fly: score = Σ query_d · (min_d + q · step_d). The
 * Σ query_d · min_d term is constant per query and cannot change the ranking, so the
 * loop computes Σ (query_d · step_d) · q — one multiply-add per element over a plain
 * Uint8Array, ~4.4M ops per query at the current corpus (measured ~8 ms single-thread).
 */
import { corpusHash, shortHash, staleArtifactWarning } from './prebuilt-index';

export const VECTOR_STORE_VERSION = 1;
export const VECTOR_MANIFEST_PATH = '/atlas-search-vectors.json';
export const VECTOR_BLOB_PATH = '/atlas-search-vectors.bin';

export interface VectorManifest {
  version: typeof VECTOR_STORE_VERSION;
  /** SHA-256 hex of `JSON.stringify(scopeTrees)` at build time — same as the index. */
  corpusHash: string;
  /** Embedding model key (SEARCH-18 winner); a different model needs a rebuild. */
  model: string;
  dims: number;
  count: number;
  quantization: 'u8-dim';
  /** Row → doc_no, in flatten order. */
  docNos: string[];
  /** Byte length of the companion blob, recorded by the build so a torn pair is detectable. */
  blobBytes?: number;
  /** SHA-256 hex of the companion blob (same purpose). */
  blobSha256?: string;
}

export interface DenseHit {
  docNo: string;
  /** Row into the flattened document array the blob was built from. */
  row: number;
  /** Approximate cosine similarity (vectors are L2-normalised at embedding time). */
  score: number;
}

export class VectorStore {
  private constructor(
    readonly manifest: VectorManifest,
    private readonly mins: Float32Array,
    private readonly steps: Float32Array,
    private readonly data: Uint8Array,
  ) {}

  /** Decodes a blob against its manifest; throws on structural mismatch. */
  static decode(manifest: VectorManifest, blob: ArrayBuffer): VectorStore {
    const { dims, count } = manifest;
    const headerBytes = dims * 4 * 2;
    if (blob.byteLength !== headerBytes + count * dims) {
      throw new Error(`vector blob is ${blob.byteLength} bytes; manifest expects ${headerBytes + count * dims}`);
    }
    return new VectorStore(
      manifest,
      new Float32Array(blob, 0, dims),
      new Float32Array(blob, dims * 4, dims),
      new Uint8Array(blob, headerBytes),
    );
  }

  /** Encodes float32 vectors into the manifest + blob pair (build script side). */
  static encode(
    vectors: Float32Array[],
    meta: Pick<VectorManifest, 'corpusHash' | 'model' | 'docNos'>,
  ): { manifest: VectorManifest; blob: ArrayBuffer } {
    const count = vectors.length;
    const dims = vectors[0]?.length ?? 0;
    if (count === 0 || dims === 0) throw new Error('cannot encode an empty vector set');

    const mins = new Float32Array(dims).fill(Infinity);
    const maxs = new Float32Array(dims).fill(-Infinity);
    for (const vector of vectors) {
      for (let d = 0; d < dims; d += 1) {
        if (vector[d] < mins[d]) mins[d] = vector[d];
        if (vector[d] > maxs[d]) maxs[d] = vector[d];
      }
    }
    const steps = new Float32Array(dims);
    for (let d = 0; d < dims; d += 1) steps[d] = (maxs[d] - mins[d]) / 255 || 1;

    const blob = new ArrayBuffer(dims * 8 + count * dims);
    new Float32Array(blob, 0, dims).set(mins);
    new Float32Array(blob, dims * 4, dims).set(steps);
    const data = new Uint8Array(blob, dims * 8);
    vectors.forEach((vector, row) => {
      for (let d = 0; d < dims; d += 1) {
        data[row * dims + d] = Math.round((vector[d] - mins[d]) / steps[d]);
      }
    });

    const manifest: VectorManifest = {
      version: VECTOR_STORE_VERSION,
      quantization: 'u8-dim',
      dims,
      count,
      ...meta,
    };
    return { manifest: { ...manifest, docNos: [...meta.docNos] }, blob };
  }

  /**
   * The dequantised vector of one row — for document-to-document similarity
   * (SEARCH-22's MMR needs cosine between candidates). Approximate to quantisation,
   * like every score this store produces.
   */
  vector(row: number): Float32Array {
    const { dims, count } = this.manifest;
    if (row < 0 || row >= count) throw new Error(`row ${row} out of range (${count} rows)`);
    const out = new Float32Array(dims);
    const base = row * dims;
    for (let d = 0; d < dims; d += 1) out[d] = this.mins[d] + this.data[base + d] * this.steps[d];
    return out;
  }

  /**
   * Exact brute-force top-k by dequantised dot product. `query` must come from the same
   * model and be L2-normalised (the QueryEmbedder guarantees both).
   */
  search(query: Float32Array, k: number): DenseHit[] {
    const { dims, count, docNos } = this.manifest;
    if (query.length !== dims) throw new Error(`query has ${query.length} dims; store has ${dims}`);

    // Fold the per-dimension step into the query once; the Σ query·min constant term is
    // ranking-irrelevant and skipped. Kept: score ≈ dot(query, vector) up to that shift.
    const scaled = new Float32Array(dims);
    let shift = 0;
    for (let d = 0; d < dims; d += 1) {
      scaled[d] = query[d] * this.steps[d];
      shift += query[d] * this.mins[d];
    }

    const scores = new Float32Array(count);
    const { data } = this;
    for (let row = 0; row < count; row += 1) {
      let dot = 0;
      const base = row * dims;
      for (let d = 0; d < dims; d += 1) dot += scaled[d] * data[base + d];
      scores[row] = dot;
    }

    const order = Array.from({ length: count }, (_, row) => row);
    order.sort((a, b) => scores[b] - scores[a]);
    return order.slice(0, k).map((row) => ({ row, docNo: docNos[row], score: scores[row] + shift }));
  }
}

/**
 * The vector store for exactly this tree, or null when there is none to be had — absent
 * artifacts, corpus mismatch, or any error. Null always means "dense rung unavailable,
 * keyword search carries on"; it is never an error state.
 */
export async function tryLoadVectorStore(
  scopeTrees: unknown,
  paths: { manifest?: string; blob?: string } = {},
): Promise<VectorStore | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const manifestResponse = await fetch(paths.manifest ?? VECTOR_MANIFEST_PATH);
    if (!manifestResponse.ok) return null;
    const manifest = (await manifestResponse.json()) as Partial<VectorManifest>;
    if (
      manifest.version !== VECTOR_STORE_VERSION ||
      manifest.quantization !== 'u8-dim' ||
      typeof manifest.corpusHash !== 'string' ||
      !Array.isArray(manifest.docNos)
    ) {
      return null;
    }

    const hash = await corpusHash(scopeTrees);
    if (!hash || hash !== manifest.corpusHash) {
      staleArtifactWarning(
        `[atlas-search] prebuilt vectors do not match this corpus (corpus ${shortHash(hash)}, artifact ${shortHash(manifest.corpusHash)}); dense rung disabled — run search:check-artifacts.`,
      );
      return null;
    }

    const blobResponse = await fetch(paths.blob ?? VECTOR_BLOB_PATH);
    if (!blobResponse.ok) return null;
    return VectorStore.decode(manifest as VectorManifest, await blobResponse.arrayBuffer());
  } catch {
    return null;
  }
}
