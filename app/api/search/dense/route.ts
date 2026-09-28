/**
 * SEARCH-20 low-memory retrieval: embed and scan the document vectors on the server,
 * returning only a bounded top-k hit list to the browser.
 */
import { QUERY_EMBEDDING_MODEL, embedQueryLocal } from '@/app/atlas/search/embedding-model';
import { RequestRateLimiter } from '@/app/server/request-rate-limit';
import { loadSearchVectorStore } from '@/app/server/search/load-search-vector-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY_CHARS = 512;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_RESULTS = 50;
const rateLimiter = new RequestRateLimiter({ perClient: 120, global: 600 });

interface DenseRouteDependencies {
  rateLimiter: Pick<RequestRateLimiter, 'check'>;
}

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function hasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function isJsonMediaType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? '';
  return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

/** Exported for route-level admission tests without exhausting the module singleton. */
export async function handleDenseSearch(request: Request, dependencies: DenseRouteDependencies): Promise<Response> {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'cross-site request' }, 403);
  if (!hasAllowedOrigin(request)) return json({ error: 'origin not allowed' }, 403);
  if (!isJsonMediaType(request.headers.get('content-type'))) return json({ error: 'content type must be JSON' }, 415);

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'request too large' }, 413);
  }

  let parsed: unknown;
  try {
    const raw = await readBoundedBody(request);
    if (raw === null) return json({ error: 'request too large' }, 413);
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'request body must be an object' }, 400);
  }
  const input = parsed as { query?: unknown; corpusHash?: unknown; limit?: unknown };

  if (typeof input.query !== 'string' || input.query.trim().length === 0) {
    return json({ error: 'query must be a string' }, 400);
  }
  if (input.query.length > MAX_QUERY_CHARS) return json({ error: 'query too long' }, 400);
  if (typeof input.corpusHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.corpusHash)) {
    return json({ error: 'invalid corpus hash' }, 400);
  }
  if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > MAX_RESULTS) {
    return json({ error: `limit must be an integer from 1 to ${MAX_RESULTS}` }, 400);
  }
  if (request.signal.aborted) return json({ error: 'request aborted' }, 499);

  const rate = dependencies.rateLimiter.check(clientKey(request));
  if (!rate.allowed) {
    return json({ error: 'too many dense search requests' }, 429, {
      'retry-after': String(rate.retryAfterSeconds),
    });
  }

  try {
    const store = await loadSearchVectorStore();
    if (input.corpusHash !== store.manifest.corpusHash) {
      return json({ error: 'vector artifact does not match this corpus' }, 409);
    }
    if (request.signal.aborted) return json({ error: 'request aborted' }, 499);

    const started = performance.now();
    const vector = await embedQueryLocal(input.query, request.signal);
    const embedded = performance.now();
    if (request.signal.aborted) return json({ error: 'request aborted' }, 499);
    const hits = store.search(vector, input.limit as number);
    const searched = performance.now();
    return json(
      {
        model: QUERY_EMBEDDING_MODEL.key,
        corpusHash: store.manifest.corpusHash,
        count: store.manifest.count,
        hits,
      },
      200,
      {
        'server-timing': `embed;dur=${(embedded - started).toFixed(1)}, search;dur=${(searched - embedded).toFixed(1)}`,
      },
    );
  } catch (error) {
    if (request.signal.aborted) return json({ error: 'request aborted' }, 499);
    console.error('[search/dense]', error);
    return json({ error: 'dense search failed' }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleDenseSearch(request, { rateLimiter });
}
