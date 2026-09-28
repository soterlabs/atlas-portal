/**
 * The embedder seam (SEARCH-19): one interface for "embed this query". The browser
 * runs the model locally; the low-memory / phone path never embeds in the browser at
 * all and calls `/api/search/dense` (server-dense-backend.ts), which keeps both halves
 * of dense retrieval on the server.
 *
 * Failure contract: `embed` may throw (model failed to load). The caller treats any
 * failure as "dense rung unavailable for this query" and lets the keyword tiers carry
 * the search — an embedder error must never break search.
 */
import { embedQueryLocal } from './embedding-model';

export interface QueryEmbedder {
  /** Embeds one query into an L2-normalised vector of `QUERY_EMBEDDING_MODEL.dims`. */
  embed(query: string): Promise<Float32Array>;
}

/** Runs the quantised model in this runtime via transformers.js (lazy-loaded). */
export class LocalQueryEmbedder implements QueryEmbedder {
  embed(query: string): Promise<Float32Array> {
    return embedQueryLocal(query);
  }
}
