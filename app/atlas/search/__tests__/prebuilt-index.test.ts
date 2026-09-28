import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { PREBUILT_INDEX_VERSION, corpusHash, tryLoadPrebuiltIndex } from '../prebuilt-index';
import { buildSearchIndexSync, loadSerializedSearchIndex, searchAtlas } from '../search-index';
import { createFixtureTree } from './fixtures';

const trees = createFixtureTree();
const docs = flattenAtlasDocuments(trees);

async function artifactFor(scopeTrees: unknown, expansions?: Record<string, string>) {
  const documents = flattenAtlasDocuments(scopeTrees as never, expansions);
  const index = buildSearchIndexSync(documents);
  return {
    version: PREBUILT_INDEX_VERSION,
    corpusHash: (await corpusHash(scopeTrees))!,
    documentCount: documents.length,
    expandedCount: Object.keys(expansions ?? {}).length,
    index: JSON.stringify(index),
  };
}

function mockFetch(payload: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(payload) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('loadSerializedSearchIndex', () => {
  it('behaves identically to a freshly built index', () => {
    const built = buildSearchIndexSync(docs);
    const restored = loadSerializedSearchIndex(JSON.stringify(built));
    for (const query of ['delegate compensation', 'faciliator', 'a.1.6', 'budget scope']) {
      const fresh = searchAtlas(built, query).hits.map((hit) => hit.id);
      const loaded = searchAtlas(restored, query).hits.map((hit) => hit.id);
      expect(loaded).toEqual(fresh);
    }
  });

  it('searches the expansion field of a prebuilt index', () => {
    // "remuneration" appears nowhere in the fixture corpus — only in the expansion.
    const expansions = { 'A.1.6.4': 'How delegate remuneration works.\nwho pays delegates?' };
    const expanded = flattenAtlasDocuments(trees, expansions);
    const index = loadSerializedSearchIndex(JSON.stringify(buildSearchIndexSync(expanded)));
    const hits = searchAtlas(index, 'remuneration').hits.map((hit) => expanded[hit.id].doc_no);
    expect(hits).toContain('A.1.6.4');
  });

  it('ranks a literal content match above an expansion-only match', () => {
    // Both documents match "compensation": A.1.6.4 in its real content, A.1.7 only via
    // an injected expansion. The generated field must not outrank the literal one.
    const expansions = { 'A.1.7': 'facilitator compensation overview' };
    const expanded = flattenAtlasDocuments(trees, expansions);
    const index = buildSearchIndexSync(expanded);
    const ranked = searchAtlas(index, 'compensation').hits.map((hit) => expanded[hit.id].doc_no);
    expect(ranked.indexOf('A.1.6.4')).toBeLessThan(ranked.indexOf('A.1.7'));
  });
});

describe('tryLoadPrebuiltIndex', () => {
  it('loads the artifact when the corpus hash matches', async () => {
    mockFetch(await artifactFor(trees));
    const index = await tryLoadPrebuiltIndex(trees);
    expect(index).not.toBeNull();
    const hits = searchAtlas(index!, 'delegate compensation').hits.map((hit) => docs[hit.id].doc_no);
    expect(hits).toContain('A.1.6.4');
  });

  it('rejects an artifact built from a different corpus', async () => {
    const artifact = await artifactFor(trees.slice(0, 1));
    mockFetch(artifact);
    expect(await tryLoadPrebuiltIndex(trees)).toBeNull();
  });

  it('returns null on missing artifact, bad payload, or fetch failure', async () => {
    mockFetch({}, false);
    expect(await tryLoadPrebuiltIndex(trees)).toBeNull();
    mockFetch({ version: 999, index: 'x' });
    expect(await tryLoadPrebuiltIndex(trees)).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await tryLoadPrebuiltIndex(trees)).toBeNull();
  });
});

describe('corpusHash', () => {
  it('reuses the digest for the same tree identity', async () => {
    const digest = vi.fn(async () => new Uint8Array(32).fill(7).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const stableTree = [{ doc_no: 'A.1' }];

    expect(await corpusHash(stableTree)).toBe(await corpusHash(stableTree));
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('retries a transient digest failure instead of caching the rejection', async () => {
    const digest = vi
      .fn<(algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error('crypto temporarily unavailable'))
      .mockResolvedValueOnce(new Uint8Array(32).fill(9).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const stableTree = [{ doc_no: 'A.2' }];

    await expect(corpusHash(stableTree)).rejects.toThrow(/temporarily unavailable/);
    await expect(corpusHash(stableTree)).resolves.toBe('09'.repeat(32));
    expect(digest).toHaveBeenCalledTimes(2);
  });
});
