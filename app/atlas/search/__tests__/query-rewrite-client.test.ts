import { describe, expect, it, vi } from 'vitest';
import { QueryRewriteClientError, rewriteAtlasQuery } from '../query-rewrite-client';

const response = {
  schemaVersion: 1,
  originalQuery: 'delegate pay',
  normalizedQuery: 'delegate pay',
  searchQuery: 'aligned delegate compensation',
  rewrite: {
    terms: ['aligned delegate', 'compensation'],
    filters: { types: [], scopes: [] },
    boolean: { must: [], should: [] },
  },
  config: { mode: 'terms-and-filters', context: 'glossary-examples', effort: 'low' },
  model: 'claude-opus-5',
  cacheHit: false,
  latencyMs: 200,
  usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0.001 },
};

describe('rewriteAtlasQuery', () => {
  it('posts only after its caller explicitly invokes it and validates the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(response));
    const pending = rewriteAtlasQuery({ query: 'delegate pay' }, undefined, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search/rewrite',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'delegate pay' }) }),
    );
  });

  it('does not let malformed success payloads reach the UI', async () => {
    await expect(
      rewriteAtlasQuery(
        { query: 'delegate pay' },
        undefined,
        vi.fn(async () => Response.json({ terms: [] })),
      ),
    ).rejects.toBeInstanceOf(QueryRewriteClientError);
  });

  it('rejects a well-formed response for another request or experiment configuration', async () => {
    await expect(
      rewriteAtlasQuery(
        { query: 'different query' },
        undefined,
        vi.fn(async () => Response.json(response)),
      ),
    ).rejects.toThrow('mismatched response');
    await expect(
      rewriteAtlasQuery(
        { query: 'delegate pay', effort: 'high' },
        undefined,
        vi.fn(async () => Response.json(response)),
      ),
    ).rejects.toThrow('mismatched response');
  });

  it('preserves aborts so stale asks remain silent', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = rewriteAtlasQuery({ query: 'delegate pay' }, controller.signal, fetchMock);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
