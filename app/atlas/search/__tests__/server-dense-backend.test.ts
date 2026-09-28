import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUERY_EMBEDDING_MODEL } from '../embedding-model';
import { DENSE_ROUND_TRIP_SAMPLE_LIMIT, DENSE_SEARCH_ROUTE_PATH, ServerDenseBackend } from '../server-dense-backend';

const hash = 'a'.repeat(64);
const documents = [{ doc_no: 'A.1' }, { doc_no: 'A.2' }, { doc_no: 'A.3' }];

function response(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: QUERY_EMBEDDING_MODEL.key,
    corpusHash: hash,
    count: documents.length,
    hits: [{ row: 1, docNo: 'A.2', score: 0.75 }],
    ...overrides,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ServerDenseBackend', () => {
  it('sends only the query contract and accepts a corpus-pinned hit list', async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new ServerDenseBackend({ corpusHash: hash, documents });

    await expect(backend.search('collateral liquidation', 10)).resolves.toEqual([
      { row: 1, docNo: 'A.2', score: 0.75 },
    ]);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(DENSE_SEARCH_ROUTE_PATH);
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'collateral liquidation',
      limit: 10,
      corpusHash: hash,
    });
    expect(path).not.toContain('atlas-search-vectors');
    expect(backend.roundTripMs).toHaveLength(1);
    expect(backend.requests).toBe(1);
    expect(backend.failedRequests).toBe(0);
  });

  it.each([
    [{ corpusHash: 'b'.repeat(64) }, /metadata/],
    [{ model: 'wrong-model' }, /metadata/],
    [{ count: 4 }, /metadata/],
    [{ hits: [{ row: 1, docNo: 'A.3', score: 0.5 }] }, /malformed hit/],
    [{ hits: [{ row: 99, docNo: 'A.2', score: 0.5 }] }, /malformed hit/],
    [{ hits: [{ row: 1, docNo: 'A.2', score: Number.NaN }] }, /malformed hit/],
    [
      {
        hits: [
          { row: 1, docNo: 'A.2', score: 0.5 },
          { row: 1, docNo: 'A.2', score: 0.4 },
        ],
      },
      /malformed hit/,
    ],
    [
      {
        hits: [
          { row: 1, docNo: 'A.2', score: 0.5 },
          { row: 2, docNo: 'A.3', score: 0.6 },
        ],
      },
      /score order/,
    ],
  ])('rejects incompatible or malformed responses', async (overrides, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(overrides)),
    );
    await expect(new ServerDenseBackend({ corpusHash: hash, documents }).search('query', 10)).rejects.toThrow(message);
  });

  it('rejects non-OK responses and invalid caller limits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const backend = new ServerDenseBackend({ corpusHash: hash, documents });
    await expect(backend.search('query', 10)).rejects.toThrow(/503/);
    expect(backend.failedRequests).toBe(1);
    await expect(backend.search('query', 0)).rejects.toThrow(/1–50/);
    await expect(backend.search('query', 51)).rejects.toThrow(/1–50/);
  });

  it('bounds response bytes before parsing on a low-memory client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { headers: { 'content-length': String(64 * 1024 + 1) } })),
    );
    const backend = new ServerDenseBackend({ corpusHash: hash, documents });
    await expect(backend.search('query', 10)).rejects.toThrow(/oversized response/);
    expect(backend.failedRequests).toBe(1);
  });

  it('aborts a stale in-flight query when a newer query starts', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 2) return response();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }),
    );
    const backend = new ServerDenseBackend({ corpusHash: hash, documents });
    const stale = backend.search('stale', 10);
    const current = backend.search('current', 10);

    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await expect(current).resolves.toHaveLength(1);
    expect(backend.requests).toBe(2);
    expect(backend.failedRequests).toBe(1);
  });

  it('keeps only a bounded diagnostic latency history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    const backend = new ServerDenseBackend({ corpusHash: hash, documents });
    for (let index = 0; index < DENSE_ROUND_TRIP_SAMPLE_LIMIT + 2; index += 1) {
      await backend.search(`query ${index}`, 10);
    }
    expect(backend.roundTripMs).toHaveLength(DENSE_ROUND_TRIP_SAMPLE_LIMIT);
  });
});
