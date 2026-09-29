import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERY_EMBEDDING_MODEL, isEmbedderWarm } from '../embedding-model';
import { flattenAtlasDocuments } from '../flatten-documents';
import { corpusHash } from '../prebuilt-index';
import { useAtlasSearch } from '../use-atlas-search';
import { createFixtureTree } from './fixtures';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('useAtlasSearch', () => {
  // The tree must be referentially stable across renders — see the hook's contract.
  it('flattens documents synchronously, before the index is ready', () => {
    const trees = createFixtureTree();
    const { result } = renderHook(() => useAtlasSearch(trees));
    expect(result.current.documents).toHaveLength(8);
  });

  it('reports the distinct document types present, sorted', () => {
    const trees = createFixtureTree();
    const { result } = renderHook(() => useAtlasSearch(trees));
    expect(result.current.types).toEqual(['Article', 'Scope', 'Section', 'Type Specification']);
  });

  it('starts not ready and returns no results until the index is built', () => {
    const trees = createFixtureTree();
    const { result } = renderHook(() => useAtlasSearch(trees));
    expect(result.current.ready).toBe(false);
    expect(result.current.search('governance')).toEqual({ hits: [], total: 0 });
  });

  it('becomes ready and then answers queries', async () => {
    const trees = createFixtureTree();
    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const { hits } = result.current.search('governance');
    expect(hits.length).toBeGreaterThan(0);
    expect(result.current.documents[hits[0].id].doc_no).toBe('A.1');
  });

  it('rebuilds when the tree identity changes', async () => {
    const { result, rerender } = renderHook(({ trees }) => useAtlasSearch(trees), {
      initialProps: { trees: createFixtureTree() },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    rerender({ trees: createFixtureTree().slice(0, 1) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.documents).toHaveLength(6);
  });

  it('ignores a stale stored preference: the mode is auto-detected only (SEARCH-80)', async () => {
    // Pre-SEARCH-80 clients may still carry the old localStorage override.
    window.localStorage.setItem('atlas-search-mode', 'low-memory');
    const trees = createFixtureTree();
    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.searchMode).toBe('local');
  });

  it('keeps the model and vector blob off-device in low-memory mode', async () => {
    const trees = createFixtureTree();
    const documents = flattenAtlasDocuments(trees);
    const target = documents.findIndex((document) => document.doc_no === 'A.1.6.4');
    const hash = await corpusHash(trees);
    expect(hash).not.toBeNull();
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'low-memory');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/atlas-search-index.json') return new Response(null, { status: 404 });
      if (path === '/api/search/dense') {
        return Response.json({
          model: QUERY_EMBEDDING_MODEL.key,
          corpusHash: hash,
          count: documents.length,
          hits: [{ row: target, docNo: documents[target].doc_no, score: 1 }],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.searchMode).toBe('low-memory'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.upgradeSearch('compensation buffers');
    });

    const paths = fetchMock.mock.calls.map(([input]) => String(input));
    expect(paths).toContain('/api/search/dense');
    expect(paths).not.toContain('/atlas-search-vectors.json');
    expect(paths).not.toContain('/atlas-search-vectors.bin');
    expect(isEmbedderWarm()).toBe(false);
    expect(result.current.denseStatus).toBe('available');
    expect(result.current.search('compensation').hits.length).toBeGreaterThan(0);
  });

  it('surfaces a failed dense upgrade without breaking keyword search', async () => {
    const trees = createFixtureTree();
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'low-memory');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input) === '/api/search/dense'
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.searchMode).toBe('low-memory'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await expect(result.current.upgradeSearch('compensation buffers')).resolves.toBeNull();
    });
    expect(result.current.denseStatus).toBe('unavailable');
    expect(result.current.search('compensation').hits.length).toBeGreaterThan(0);
  });

  it('retries backend creation after a transient corpus-hash failure', async () => {
    const trees = createFixtureTree();
    const documents = flattenAtlasDocuments(trees);
    const target = documents.findIndex((document) => document.doc_no === 'A.1.6.4');
    const hash = '09'.repeat(32);
    const digest = vi
      .fn<(algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error('crypto temporarily unavailable'))
      .mockResolvedValue(new Uint8Array(32).fill(9).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'low-memory');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/atlas-search-index.json') return new Response(null, { status: 404 });
      return Response.json({
        model: QUERY_EMBEDDING_MODEL.key,
        corpusHash: hash,
        count: documents.length,
        hits: [{ row: target, docNo: documents[target].doc_no, score: 1 }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await expect(result.current.upgradeSearch('compensation buffers')).resolves.toBeNull();
    });
    await act(async () => {
      await expect(result.current.upgradeSearch('compensation buffers')).resolves.not.toBeNull();
    });

    expect(digest).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/search/dense')).toHaveLength(1);
    expect(result.current.denseStatus).toBe('available');
  });
});
