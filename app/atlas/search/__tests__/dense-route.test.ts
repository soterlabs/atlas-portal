/** SEARCH-20: bounded, corpus-pinned server-side dense retrieval. */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST, handleDenseSearch } from '@/app/api/search/dense/route';
import { loadSearchVectorStore } from '@/app/server/search/load-search-vector-store';
import { QUERY_EMBEDDING_MODEL, embedQueryLocal } from '../embedding-model';
import { VectorStore } from '../vector-store';

const corpusHash = 'a'.repeat(64);
const vectors = Array.from({ length: 3 }, (_, row) => {
  const vector = new Float32Array(QUERY_EMBEDDING_MODEL.dims);
  vector[row] = 1;
  return vector;
});
const encoded = VectorStore.encode(vectors, {
  corpusHash,
  model: QUERY_EMBEDDING_MODEL.key,
  docNos: ['A.1', 'A.2', 'A.3'],
});
const store = VectorStore.decode(encoded.manifest, encoded.blob);

vi.mock('@/app/server/search/load-search-vector-store', () => ({
  loadSearchVectorStore: vi.fn(),
}));

vi.mock('../embedding-model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../embedding-model')>();
  return {
    ...original,
    embedQueryLocal: vi.fn(async (query: string) => {
      if (query === 'boom') throw new Error('model exploded');
      const vector = new Float32Array(QUERY_EMBEDDING_MODEL.dims);
      vector[1] = 1;
      return vector;
    }),
  };
});

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/search/dense', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ query: 'governance process', corpusHash, limit: 2, ...overrides });
}

beforeEach(() => {
  vi.mocked(loadSearchVectorStore).mockReset().mockResolvedValue(store);
  vi.mocked(embedQueryLocal).mockClear();
});

describe('POST /api/search/dense', () => {
  it('embeds and searches on the server, returning bounded metadata-pinned hits', async () => {
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('server-timing')).toMatch(/embed;dur=.*search;dur=/);
    const body = (await response.json()) as {
      model: string;
      corpusHash: string;
      count: number;
      hits: Array<{ row: number; docNo: string; score: number }>;
    };
    expect(body).toMatchObject({ model: QUERY_EMBEDDING_MODEL.key, corpusHash, count: 3 });
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]).toMatchObject({ row: 1, docNo: 'A.2' });
    expect(embedQueryLocal).toHaveBeenCalledWith('governance process', expect.any(AbortSignal));
  });

  it('rejects malformed, oversized, cross-origin, and unbounded requests before inference', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request('null'))).status).toBe(400);
    expect((await POST(request('[]'))).status).toBe(400);
    expect((await POST(request(validBody({ query: ' ' })))).status).toBe(400);
    expect((await POST(request(validBody({ query: 'q'.repeat(513) })))).status).toBe(400);
    expect((await POST(request(validBody({ corpusHash: 'wrong' })))).status).toBe(400);
    expect((await POST(request(validBody({ limit: 0 })))).status).toBe(400);
    expect((await POST(request(validBody({ limit: 51 })))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ query: 'x'.repeat(5000) })))).status).toBe(413);
    expect((await POST(request(validBody({ query: '🙂'.repeat(1100) })))).status).toBe(413);
    expect((await POST(request(validBody(), { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await POST(request(validBody(), { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await POST(request(validBody(), { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await POST(request(validBody(), { 'content-length': '5000' }))).status).toBe(413);
    expect(embedQueryLocal).not.toHaveBeenCalled();
  });

  it('stops an already-aborted request before loading or inference', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new Request('http://localhost/api/search/dense', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody(),
      signal: controller.signal,
    });

    expect((await POST(aborted)).status).toBe(499);
    expect(loadSearchVectorStore).not.toHaveBeenCalled();
    expect(embedQueryLocal).not.toHaveBeenCalled();
  });

  it('rate-limits valid work before loading artifacts or running inference', async () => {
    const response = await handleDenseSearch(request(validBody(), { 'x-vercel-forwarded-for': '203.0.113.4' }), {
      rateLimiter: { check: () => ({ allowed: false, retryAfterSeconds: 17 }) },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(await response.json()).toEqual({ error: 'too many dense search requests' });
    expect(loadSearchVectorStore).not.toHaveBeenCalled();
    expect(embedQueryLocal).not.toHaveBeenCalled();
  });

  it('rejects stale corpora before inference', async () => {
    const response = await POST(request(validBody({ corpusHash: 'b'.repeat(64) })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'vector artifact does not match this corpus' });
    expect(embedQueryLocal).not.toHaveBeenCalled();
  });

  it('maps artifact and inference failures to a non-leaking 500', async () => {
    vi.mocked(loadSearchVectorStore).mockRejectedValueOnce(new Error('disk exploded'));
    let response = await POST(request(validBody()));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'dense search failed' });

    response = await POST(request(validBody({ query: 'boom' })));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'dense search failed' });
  });
});
