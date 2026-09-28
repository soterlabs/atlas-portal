/**
 * The query-embedding model the portal ships (SEARCH-18 winner, served per SEARCH-19):
 * bge-small-en-v1.5 at q8, CLS pooling, the BGE query instruction prefix. One source of
 * truth for the browser embedder and the server dense route (`/api/search/dense`), which
 * run this same function (transformers.js works in both runtimes), so the two sides
 * cannot drift apart.
 *
 * The scripts-side registry (`scripts/embedding-eval/models.ts`) carries the same spec
 * under the key recorded in the vector manifest; the store loader refuses a manifest
 * whose model key differs from this one.
 *
 * The transformers.js pipeline is a lazy module singleton: nothing is downloaded or
 * initialised until the first dense query needs it (§9b — a keyword-only session never
 * pays for the model).
 */

export const QUERY_EMBEDDING_MODEL = {
  /** Must match the `model` field of the vector manifest. */
  key: 'bge-small',
  repo: 'Xenova/bge-small-en-v1.5',
  dims: 384,
  pooling: 'cls',
  /** BGE's asymmetric instruction prefix — queries only, never passages. */
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  dtype: 'q8',
} as const;

type Extractor = (
  text: string,
  options: { pooling: 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array; dispose?: () => void }>;

let extractorPromise: Promise<Extractor> | null = null;

function loadExtractor(): Promise<Extractor> {
  extractorPromise ??= import('@huggingface/transformers')
    .then(({ env, pipeline }) => {
      // Vercel's deployed function bundle is read-only. A clean cold start without
      // build-cached model files must cache the remote model in writable ephemeral
      // storage; subsequent calls in the same instance reuse the pipeline singleton.
      if (typeof window === 'undefined' && process.env.VERCEL === '1') {
        env.cacheDir = '/tmp/atlas-transformers-cache';
      }
      return pipeline('feature-extraction', QUERY_EMBEDDING_MODEL.repo, {
        dtype: QUERY_EMBEDDING_MODEL.dtype,
      }) as Promise<Extractor>;
    })
    .catch((error) => {
      // A transient model/CDN failure must not poison this browser/server process.
      extractorPromise = null;
      throw error;
    });
  return extractorPromise;
}

/** True once the model is loaded (or loading) — lets callers report cold vs warm. */
export function isEmbedderWarm(): boolean {
  return extractorPromise !== null;
}

/**
 * Embeds one query into an L2-normalised Float32Array of `QUERY_EMBEDDING_MODEL.dims`.
 * First call downloads/initialises the model (seconds cold, cached thereafter); later
 * calls are tens of milliseconds.
 */
export async function embedQueryLocal(query: string, signal?: AbortSignal): Promise<Float32Array> {
  const extractor = await loadExtractor();
  if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted', 'AbortError');
  const output = await extractor(`${QUERY_EMBEDDING_MODEL.queryPrefix}${query}`, {
    pooling: QUERY_EMBEDDING_MODEL.pooling,
    normalize: true,
  });
  try {
    if (output.data.length < QUERY_EMBEDDING_MODEL.dims) {
      throw new Error(`query model returned ${output.data.length} dimensions`);
    }
    const vector = new Float32Array(output.data.subarray(0, QUERY_EMBEDDING_MODEL.dims));
    let normSquared = 0;
    for (const value of vector) {
      if (!Number.isFinite(value)) throw new Error('query model returned a non-finite embedding');
      normSquared += value * value;
    }
    // `normalize: true` is part of the stored-vector scoring contract. A generous
    // tolerance catches zero/corrupt output without perturbing valid model values.
    if (Math.abs(Math.sqrt(normSquared) - 1) > 0.02) {
      throw new Error('query model returned a non-normalised embedding');
    }
    return vector;
  } finally {
    output.dispose?.();
  }
}
