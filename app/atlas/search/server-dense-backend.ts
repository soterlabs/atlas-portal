/**
 * Browser client for SEARCH-20's server-side dense retrieval path.
 *
 * Unlike a query-only embedding route, this endpoint keeps both halves of dense retrieval on
 * the server: the query model and the document-vector store. Only a bounded top-k hit
 * list crosses the network, so low-memory clients download neither large artifact.
 */
import { QUERY_EMBEDDING_MODEL } from './embedding-model';
import type { FlatAtlasDocument } from './flatten-documents';
import type { RemoteDenseBackend } from './hybrid-search';
import { corpusHash } from './prebuilt-index';
import type { DenseHit } from './vector-store';

export const DENSE_SEARCH_ROUTE_PATH = '/api/search/dense';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
export const DENSE_ROUND_TRIP_SAMPLE_LIMIT = 256;

interface ServerDenseResponse {
  model?: unknown;
  corpusHash?: unknown;
  count?: unknown;
  hits?: unknown;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('dense search route returned an oversized response');
  }
  if (!response.body) throw new Error('dense search route returned an empty response');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('dense search route returned an oversized response');
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    throw new Error('dense search route returned invalid JSON');
  }
}

export interface ServerDenseBackendOptions {
  endpoint?: string;
  corpusHash: string;
  documents: Pick<FlatAtlasDocument, 'doc_no'>[];
}

/**
 * A remote backend pinned to the exact corpus in the browser. Every response is
 * checked again — including row-to-document-number identity — before ranking sees it.
 */
export class ServerDenseBackend implements RemoteDenseBackend {
  readonly kind = 'remote' as const;
  readonly count: number;
  readonly roundTripMs: number[] = [];
  requests = 0;
  failedRequests = 0;

  private readonly endpoint: string;
  private readonly expectedCorpusHash: string;
  private readonly docNos: string[];
  private activeController: AbortController | null = null;

  constructor({
    endpoint = DENSE_SEARCH_ROUTE_PATH,
    corpusHash: expectedCorpusHash,
    documents,
  }: ServerDenseBackendOptions) {
    this.endpoint = endpoint;
    this.expectedCorpusHash = expectedCorpusHash;
    this.docNos = documents.map((document) => document.doc_no);
    this.count = this.docNos.length;
  }

  async search(query: string, limit: number): Promise<DenseHit[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('dense result limit must be 1–50');

    this.requests += 1;
    const controller = new AbortController();
    // Search-modal upgrades are latest-wins. Cancel a stale request so a cold model
    // load does not fan out into one inference for every paused keystroke.
    this.activeController?.abort();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = performance.now();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit, corpusHash: this.expectedCorpusHash }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`dense search route failed: ${response.status}`);

      const body = (await readBoundedJson(response)) as ServerDenseResponse;
      if (
        body.model !== QUERY_EMBEDDING_MODEL.key ||
        body.corpusHash !== this.expectedCorpusHash ||
        body.count !== this.count ||
        !Array.isArray(body.hits)
      ) {
        throw new Error('dense search route returned incompatible metadata');
      }

      const seen = new Set<number>();
      const hits = body.hits.map((candidate): DenseHit => {
        if (!candidate || typeof candidate !== 'object') throw new Error('dense search route returned a malformed hit');
        const { row, docNo, score } = candidate as Record<string, unknown>;
        if (
          !Number.isInteger(row) ||
          (row as number) < 0 ||
          (row as number) >= this.count ||
          typeof docNo !== 'string' ||
          docNo !== this.docNos[row as number] ||
          typeof score !== 'number' ||
          !Number.isFinite(score) ||
          seen.has(row as number)
        ) {
          throw new Error('dense search route returned a malformed hit');
        }
        seen.add(row as number);
        return { row: row as number, docNo, score };
      });
      if (hits.length > limit) throw new Error('dense search route exceeded the requested limit');
      if (hits.some((hit, index) => index > 0 && hit.score > hits[index - 1].score)) {
        throw new Error('dense search route returned hits out of score order');
      }

      // Include response transfer, JSON parsing and validation: this is the latency the
      // low-memory client actually experiences, not merely time-to-headers.
      const elapsed = performance.now() - started;
      if (this.roundTripMs.length >= DENSE_ROUND_TRIP_SAMPLE_LIMIT) this.roundTripMs.shift();
      this.roundTripMs.push(elapsed);
      try {
        performance.clearMeasures?.('atlas-server-dense-roundtrip');
        performance.measure('atlas-server-dense-roundtrip', { start: started, end: started + elapsed });
      } catch {
        // Optional diagnostic only; old Performance implementations lack measure options.
      }
      return hits;
    } catch (error) {
      this.failedRequests += 1;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

/** Null only when WebCrypto cannot bind requests to the exact client corpus. */
export async function createServerDenseBackend(
  scopeTrees: unknown,
  documents: Pick<FlatAtlasDocument, 'doc_no'>[],
): Promise<ServerDenseBackend | null> {
  const hash = await corpusHash(scopeTrees);
  return hash ? new ServerDenseBackend({ corpusHash: hash, documents }) : null;
}
