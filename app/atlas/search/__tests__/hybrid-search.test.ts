/**
 * SEARCH-21 part 2: the hybrid path — the gated rung (hyb10r-L2-c), the selection
 * seam, and the never-break-search failure contract. The dense side is a real
 * VectorStore over synthetic one-hot vectors, so which document the "model" prefers is
 * under test control and nothing downloads anything.
 */
import { describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import {
  type DenseBackend,
  HYBRID_RUNG_SIZE,
  HYBRID_RUNG_WEAK_SCORE,
  HYBRID_STRICT_GATE,
  type RemoteDenseBackend,
  canonicalDenseQuery,
  composeHybrid,
  searchAtlasHybrid,
} from '../hybrid-search';
import { type AtlasSearchHit, type AtlasSearchTiers, buildSearchIndexSync, searchAtlas } from '../search-index';
import { VectorStore } from '../vector-store';
import { mapAtlasVocabulary } from '../vocabulary';
import { createDoc, createFixtureTree } from './fixtures';

const documents = flattenAtlasDocuments(createFixtureTree());
const index = buildSearchIndexSync(documents);

/** One-hot vectors: row i is e_i, so a one-hot query retrieves exactly that row first. */
function oneHotStore(count: number): VectorStore {
  const vectors = Array.from({ length: count }, (_, row) => {
    const vector = new Float32Array(count);
    vector[row] = 1;
    return vector;
  });
  const { manifest, blob } = VectorStore.encode(vectors, {
    corpusHash: 'test',
    model: 'bge-small',
    docNos: documents.map((doc) => doc.doc_no),
  });
  return VectorStore.decode(manifest, blob);
}

function oneHot(row: number): Float32Array {
  const vector = new Float32Array(documents.length);
  vector[row] = 1;
  return vector;
}

function backend(targetRow: number): DenseBackend {
  return { store: oneHotStore(documents.length), embedder: { embed: vi.fn(async () => oneHot(targetRow)) } };
}

const hit = (id: number): AtlasSearchHit => ({ id, score: 1, terms: [], fields: [] });

describe('canonicalDenseQuery', () => {
  it('is word-order independent and drops stopwords', () => {
    expect(canonicalDenseQuery('process governance')).toBe(canonicalDenseQuery('governance process'));
    expect(canonicalDenseQuery('how does the compensation work')).not.toContain('the');
    expect(canonicalDenseQuery('   ')).toBe('');
  });

  it('leaves dense retrieval literal when SEARCH-09 adjusts a keyword position', () => {
    expect(canonicalDenseQuery('maximum cap')).not.toBe(canonicalDenseQuery('maximum tolerance'));
    expect(canonicalDenseQuery('maximum cap')).toBe('cap maximum');
  });
});

describe('composeHybrid', () => {
  const tiers: AtlasSearchTiers = { strict: [hit(1)], relaxed: [hit(2), hit(3)], total: 3 };
  const dense = [
    { row: 1, docNo: 'kept-out (in strict)', score: 0.9 },
    { row: 5, docNo: 'rung-1', score: 0.8 },
    { row: 3, docNo: 'rung-2 (also in relaxed)', score: 0.7 },
  ];

  it('inserts the deduplicated rung between strict and relaxed when strict is thin', () => {
    const { hits, total } = composeHybrid(tiers, dense, { limit: 10 });
    expect(hits.map((entry) => entry.id)).toEqual([1, 5, 3, 2]); // strict, rung (minus strict), relaxed (minus rung)
    expect(total).toBe(4);
  });

  it('adds no rung when the strict pass is confident', () => {
    const confident: AtlasSearchTiers = {
      strict: Array.from({ length: HYBRID_STRICT_GATE }, (_, i) => hit(i + 100)),
      relaxed: [hit(2)],
      total: HYBRID_STRICT_GATE + 1,
    };
    const { hits } = composeHybrid(confident, dense, { limit: 20 });
    expect(hits.map((entry) => entry.id)).toEqual([...confident.strict.map((entry) => entry.id), 2]);
  });

  it('a WEAK rung guess yields to a relaxed keyword match of the same document (bug 10)', () => {
    const weakGuessOnRelaxed = [{ row: 3, docNo: 'rung-weak (also in relaxed)', score: HYBRID_RUNG_WEAK_SCORE - 0.1 }];
    const { hits } = composeHybrid(tiers, weakGuessOnRelaxed, { limit: 10 });
    const three = hits.find((entry) => entry.id === 3)!;
    expect(three.provenance).toBe('relaxed');
    expect(three.weak).toBeUndefined();
    expect(hits.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it('a STRONG rung row keeps precedence over the relaxed copy', () => {
    const { hits } = composeHybrid(tiers, [{ row: 3, docNo: 'rung-strong', score: 0.9 }], { limit: 10 });
    expect(hits.find((entry) => entry.id === 3)!.provenance).toBe('rung');
  });

  it('caps the rung at its size', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ row: 200 + i, docNo: String(i), score: 1 - i / 100 }));
    const { hits } = composeHybrid({ strict: [], relaxed: [], total: 0 }, many, { limit: 100 });
    expect(hits).toHaveLength(HYBRID_RUNG_SIZE);
  });

  it('keeps the dense gate based on literal strict matches after a vocabulary promotion', () => {
    const promoted: AtlasSearchTiers = {
      strict: [...Array.from({ length: HYBRID_STRICT_GATE - 1 }, (_, i) => hit(i)), { ...hit(99), vocabulary: true }],
      relaxed: [],
      total: HYBRID_STRICT_GATE,
      literalStrictCount: HYBRID_STRICT_GATE - 1,
      vocabulary: mapAtlasVocabulary('maximum cap')!,
    };
    const { hits } = composeHybrid(promoted, [{ row: 100, docNo: 'dense', score: 0.9 }], { limit: 20 });
    expect(hits.some((entry) => entry.id === 100 && entry.provenance === 'rung')).toBe(true);
  });

  it('tags provenance, marks weak rung guesses, and flags an all-guess result (SEARCH-30)', () => {
    const { hits: mixed } = composeHybrid(tiers, dense, { limit: 10 });
    expect(mixed.map((entry) => entry.provenance)).toEqual(['strict', 'rung', 'rung', 'relaxed']);

    // Rung scores straddle the weak line: 0.9 is a match, 0.5 a guess.
    const guesses = [
      { row: 5, docNo: 'strong', score: 0.9 },
      { row: 6, docNo: 'weak', score: 0.5 },
    ];
    const results = composeHybrid({ strict: [], relaxed: [], total: 0 }, guesses, { limit: 10 });
    expect(results.hits.map((entry) => entry.weak)).toEqual([undefined, true]);
    expect(results.noKeywordMatches).toBe(true);
    // Any keyword match at all clears the flag.
    expect(composeHybrid(tiers, dense, { limit: 10 }).noKeywordMatches).toBeUndefined();
  });

  it('hands the selection stage the full candidate list and cuts after it', () => {
    const seen: number[][] = [];
    const { hits } = composeHybrid(tiers, dense, {
      limit: 2,
      select: (candidates) => {
        seen.push(candidates.map((entry) => entry.id));
        return [...candidates].reverse();
      },
    });
    expect(seen[0]).toEqual([1, 5, 3, 2]); // the stage sees the pool, not a truncated page
    expect(hits.map((entry) => entry.id)).toEqual([2, 3]); // its output, cut to the limit
  });

  it('decides the vocabulary notice from the selection stage output, not the pre-selection pool (SEARCH-37)', () => {
    const vocabulary = mapAtlasVocabulary('maximum cap')!;
    const vocabularyTiers: AtlasSearchTiers = {
      strict: [hit(1), { ...hit(2), vocabulary: true }],
      relaxed: [],
      total: 2,
      vocabulary,
    };

    // A stage that pushes the promoted row off the returned page: the reader never sees
    // it, so the modal must not claim an Atlas-vocabulary result.
    const demoted = composeHybrid(vocabularyTiers, [], {
      limit: 1,
      select: (candidates) =>
        [...candidates].sort((a, b) => Number(a.vocabulary ?? false) - Number(b.vocabulary ?? false)),
    });
    expect(demoted.hits.some((entry) => entry.vocabulary)).toBe(false);
    expect(demoted.vocabulary).toBeUndefined();

    // The same tiers and limit, with a stage that keeps it visible.
    const kept = composeHybrid(vocabularyTiers, [], {
      limit: 1,
      select: (candidates) =>
        [...candidates].sort((a, b) => Number(b.vocabulary ?? false) - Number(a.vocabulary ?? false)),
    });
    expect(kept.hits.some((entry) => entry.vocabulary)).toBe(true);
    expect(kept.vocabulary).toEqual(vocabulary);
  });

  it('reports a vocabulary intervention only when its result is on the returned page', () => {
    const vocabulary = mapAtlasVocabulary('maximum cap')!;
    const vocabularyTiers: AtlasSearchTiers = {
      strict: [hit(1), { ...hit(2), vocabulary: true }],
      relaxed: [],
      total: 2,
      vocabulary,
    };
    expect(composeHybrid(vocabularyTiers, [], { limit: 1 }).vocabulary).toBeUndefined();
    expect(composeHybrid(vocabularyTiers, [], { limit: 2 }).vocabulary).toEqual(vocabulary);
  });
});

describe('searchAtlasHybrid', () => {
  const target = documents.findIndex((doc) => doc.doc_no === 'A.1.6.4');

  it('upgrades a thin-strict query with the dense rung', async () => {
    const dense = backend(target);
    const results = await searchAtlasHybrid(index, documents, 'compensation buffers', async () => dense);
    expect(results).not.toBeNull();
    expect(results!.hits.some((entry) => entry.id === target)).toBe(true);
  });

  it('uses a remote hit provider without changing the measured hybrid composition', async () => {
    const search = vi.fn(async () => [
      { row: target, docNo: documents[target].doc_no, score: 1 },
      { row: 0, docNo: documents[0].doc_no, score: 0.5 },
    ]);
    const remote: RemoteDenseBackend = { kind: 'remote', count: documents.length, search };
    const states: string[] = [];
    const results = await searchAtlasHybrid(index, documents, 'buffers compensation', async () => remote, {
      onDenseState: (state) => states.push(state),
    });

    expect(search).toHaveBeenCalledWith('buffers compensation', HYBRID_RUNG_SIZE * 5);
    expect(results!.hits.some((entry) => entry.id === target)).toBe(true);
    expect(states).toEqual(['loading', 'available']);
  });

  it('embeds both word orders to the same canonical text, giving identical results', async () => {
    const dense = backend(target);
    const forward = await searchAtlasHybrid(index, documents, 'compensation buffers', async () => dense);
    const reversed = await searchAtlasHybrid(index, documents, 'buffers compensation', async () => dense);
    const embed = dense.embedder.embed as ReturnType<typeof vi.fn>;
    expect(embed.mock.calls[0][0]).toBe(embed.mock.calls[1][0]);
    expect(forward!.hits.map((entry) => entry.id)).toEqual(reversed!.hits.map((entry) => entry.id));
  });

  it('applies type and scope filters to the dense rung', async () => {
    const scopeRow = documents.findIndex((doc) => doc.type === 'Scope');
    const dense = backend(scopeRow);
    const results = await searchAtlasHybrid(index, documents, 'compensation buffers', async () => dense, {
      types: ['Section'],
    });
    expect(results!.hits.every((entry) => documents[entry.id].type === 'Section')).toBe(true);

    const excluded = await searchAtlasHybrid(index, documents, 'compensation buffers', async () => dense, {
      includeId: (id) => id !== target,
    });
    expect(excluded === null || excluded.hits.every((entry) => entry.id !== target)).toBe(true);
  });

  it('returns null and never loads the backend when strict is confident', async () => {
    const shared = 'liquidation threshold parameters';
    const tree = [
      createDoc('Scope', 'B.1', 'Big Scope', shared, {
        articles: Array.from({ length: HYBRID_STRICT_GATE + 2 }, (_, i) =>
          createDoc('Article', `B.1.${i + 1}`, `Doc ${i + 1}`, shared),
        ),
      }),
    ];
    const bigDocs = flattenAtlasDocuments(tree);
    const bigIndex = buildSearchIndexSync(bigDocs);
    expect(searchAtlas(bigIndex, shared).hits.length).toBeGreaterThanOrEqual(HYBRID_STRICT_GATE);

    const provider = vi.fn(async () => backend(0));
    expect(await searchAtlasHybrid(bigIndex, bigDocs, shared, provider)).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it('runs an opted-in selection stage on a confident strict pass, dense-free (SEARCH-29)', async () => {
    const shared = 'liquidation threshold parameters';
    const tree = [
      createDoc('Scope', 'B.1', 'Big Scope', shared, {
        articles: Array.from({ length: HYBRID_STRICT_GATE + 2 }, (_, i) =>
          createDoc('Article', `B.1.${i + 1}`, `Doc ${i + 1}`, shared),
        ),
      }),
    ];
    const bigDocs = flattenAtlasDocuments(tree);
    const bigIndex = buildSearchIndexSync(bigDocs);
    const provider = vi.fn(async () => backend(0));

    // A stage without the opt-in keeps the shipped SEARCH-22 semantics: null.
    const stage = vi.fn((candidates: AtlasSearchHit[]) => [...candidates].reverse());
    expect(await searchAtlasHybrid(bigIndex, bigDocs, shared, provider, { select: stage })).toBeNull();
    expect(stage).not.toHaveBeenCalled();

    // Opted in, the stage permutes the keyword candidates — and the dense backend is
    // still never loaded (§9b).
    const staged = await searchAtlasHybrid(bigIndex, bigDocs, shared, provider, {
      select: stage,
      applySelectWithoutRung: true,
    });
    const keyword = searchAtlas(bigIndex, shared, { limit: 200 });
    expect(staged!.hits.map((entry) => entry.id)).toEqual([...keyword.hits.map((entry) => entry.id)].reverse());
    expect(provider).not.toHaveBeenCalled();
  });

  it('returns null on a missing backend, a stale store, or an embedder failure', async () => {
    expect(await searchAtlasHybrid(index, documents, 'compensation buffers', async () => null)).toBeNull();

    const stale = backend(target);
    expect(
      await searchAtlasHybrid(index, [...documents, documents[0]], 'compensation buffers', async () => stale),
    ).toBeNull();

    const failing: DenseBackend = {
      store: oneHotStore(documents.length),
      embedder: {
        embed: async () => {
          throw new Error('model exploded');
        },
      },
    };
    expect(await searchAtlasHybrid(index, documents, 'compensation buffers', async () => failing)).toBeNull();
  });

  it('reports an unavailable remote backend while preserving the never-throw contract', async () => {
    const states: string[] = [];
    const remote: RemoteDenseBackend = {
      kind: 'remote',
      count: documents.length,
      search: async () => {
        throw new Error('network down');
      },
    };
    await expect(
      searchAtlasHybrid(index, documents, 'compensation buffers', async () => remote, {
        onDenseState: (state) => states.push(state),
      }),
    ).resolves.toBeNull();
    expect(states).toEqual(['loading', 'unavailable']);
  });

  it('does not let an observational state callback alter retrieval', async () => {
    const remote: RemoteDenseBackend = {
      kind: 'remote',
      count: documents.length,
      search: async () => [{ row: target, docNo: documents[target].doc_no, score: 1 }],
    };
    const results = await searchAtlasHybrid(index, documents, 'compensation buffers', async () => remote, {
      onDenseState: () => {
        throw new Error('UI unmounted');
      },
    });
    expect(results!.hits.some((entry) => entry.id === target)).toBe(true);
  });
});

describe('composeHybrid with a family-distinct rung (SEARCH-22 part B hook)', () => {
  it('keeps only the first dense result per family, backfilling with later families', () => {
    const tiers: AtlasSearchTiers = { strict: [], relaxed: [], total: 0 };
    const dense = [
      { row: 1, docNo: 'F1.a', score: 0.9 },
      { row: 2, docNo: 'F1.b', score: 0.8 }, // same family as row 1 → dropped
      { row: 3, docNo: 'F2.a', score: 0.7 },
    ];
    const familyOf = (docNo: string) => docNo.split('.')[0];
    const { hits } = composeHybrid(tiers, dense, { limit: 10, rungFamilyOf: familyOf });
    expect(hits.map((entry) => entry.id)).toEqual([1, 3]);

    // Without the hook, behaviour is the shipped SEARCH-21 rung, byte-identical.
    const { hits: shipped } = composeHybrid(tiers, dense, { limit: 10 });
    expect(shipped.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });
});

describe('cluster-first dense rung (SEARCH-44, adopted 2026-09-04)', () => {
  // 80 synthetic docs whose dense ranking is row order by construction (2-d vectors on
  // a quarter circle; the query is [1, 0]). The only Section sits at dense rank ~65 —
  // under the retired top-50 window a type:Section filter starved the rung; the
  // adopted cluster-first selection walks the full ranking and cannot starve.
  const bigTree = [
    createDoc('Scope', 'C.1', 'Adaptive Scope', 'adaptive recall fixture', {
      articles: Array.from({ length: 79 }, (_, i) =>
        createDoc(i === 63 ? 'Section' : 'Article', `C.1.${i + 1}`, `Filler ${i + 1}`, 'filler body'),
      ),
    }),
  ];
  const bigDocs = flattenAtlasDocuments(bigTree);
  const bigIndex = buildSearchIndexSync(bigDocs);
  const targetRow = bigDocs.findIndex((doc) => doc.type === 'Section');

  function angledStore(): VectorStore {
    const vectors = bigDocs.map((_, row) => {
      const angle = (row / bigDocs.length) * (Math.PI / 2);
      return new Float32Array([Math.cos(angle), Math.sin(angle)]);
    });
    const { manifest, blob } = VectorStore.encode(vectors, {
      corpusHash: 'test',
      model: 'bge-small',
      docNos: bigDocs.map((doc) => doc.doc_no),
    });
    return VectorStore.decode(manifest, blob);
  }

  function angledBackend(): DenseBackend {
    return { store: angledStore(), embedder: { embed: async () => new Float32Array([1, 0]) } };
  }

  it('fills the rung from the full ranking in one scan — a filter cannot starve it', async () => {
    const dense = angledBackend();
    const spy = vi.spyOn(dense.store, 'search');
    const results = await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive recall', async () => dense, {
      types: ['Section'],
    });
    expect(spy.mock.calls.map((call) => call[1])).toEqual([bigDocs.length]);
    const target = results!.hits.find((entry) => entry.id === targetRow);
    expect(target?.provenance).toBe('rung');
  });

  it('unfiltered: the same single scan, rung capped at HYBRID_RUNG_SIZE', async () => {
    const dense = angledBackend();
    const spy = vi.spyOn(dense.store, 'search');
    const results = await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive recall', async () => dense);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([bigDocs.length]);
    expect(results!.hits.filter((entry) => entry.provenance === 'rung')).toHaveLength(HYBRID_RUNG_SIZE);
  });

  it('one representative per family, in ranking order', async () => {
    const dense = angledBackend();
    // Rows 0–19 form one family; every other document is its own family. Row 0 is in
    // the strict keyword results, so the family is represented by row 1.
    const familyOf = (docNo: string) => (bigDocs.findIndex((doc) => doc.doc_no === docNo) < 20 ? 'big-family' : docNo);
    const results = await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive recall', async () => dense, {
      rungFamilyOf: familyOf,
    });
    const rungIds = results!.hits.filter((entry) => entry.provenance === 'rung').map((entry) => entry.id);
    expect(rungIds).toEqual([1, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
  });

  it('remote backend keeps the measured over-fetch (the route caps at 50)', async () => {
    const search = vi.fn(async (_query: string, limit: number) =>
      Array.from({ length: Math.min(limit, 50) }, (_, i) => ({
        row: i,
        docNo: bigDocs[i].doc_no,
        score: 1 - i / 100,
      })),
    );
    const remote: RemoteDenseBackend = { kind: 'remote', count: bigDocs.length, search };
    await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive recall', async () => remote, { types: ['Section'] });
    expect(search.mock.calls.map((call) => call[1])).toEqual([50]);
  });

  it('a fields restriction disables the rung — title: searches cannot leak off-title rows (SEARCH-54)', async () => {
    const dense = angledBackend();
    const spy = vi.spyOn(dense.store, 'search');
    const bare = await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive', async () => dense, { fields: ['name'] });
    expect(bare).toBeNull(); // keyword results stand
    expect(spy).not.toHaveBeenCalled();

    const staged = await searchAtlasHybrid(bigIndex, bigDocs, 'adaptive', async () => dense, {
      fields: ['name'],
      select: (candidates) => candidates,
      applySelectWithoutRung: true,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(staged!.hits.every((entry) => entry.provenance !== 'rung')).toBe(true);
    expect(staged!.hits.every((entry) => /adaptive/i.test(bigDocs[entry.id].name))).toBe(true);
  });

  it('an identifier-shaped query skips the rung; a doc-number query does not (SEARCH-54)', async () => {
    const addressTree = [
      createDoc(
        'Scope',
        'D.1',
        'Treasury Wallets',
        'Custody wallet 0xAbC123Def4567890AbC123Def4567890AbC123De holds funds.',
      ),
    ];
    const addressDocs = flattenAtlasDocuments(addressTree);
    const addressIndex = buildSearchIndexSync(addressDocs);
    const addressStore: DenseBackend = {
      store: (() => {
        const { manifest, blob } = VectorStore.encode([Float32Array.from([1, 0])], {
          corpusHash: 'test',
          model: 'bge-small',
          docNos: ['D.1'],
        });
        return VectorStore.decode(manifest, blob);
      })(),
      embedder: { embed: vi.fn(async () => Float32Array.from([1, 0])) },
    };
    const spy = vi.spyOn(addressStore.store, 'search');
    const result = await searchAtlasHybrid(
      addressIndex,
      addressDocs,
      '0xAbC123Def4567890AbC123Def4567890AbC123De',
      async () => addressStore,
    );
    expect(result).toBeNull(); // keyword exact match stands alone
    expect(spy).not.toHaveBeenCalled();

    // A doc-number query is NOT an identifier: the rung still runs for it.
    const dense = angledBackend();
    const denseSpy = vi.spyOn(dense.store, 'search');
    await searchAtlasHybrid(bigIndex, bigDocs, 'c.1.64', async () => dense);
    expect(denseSpy.mock.calls.map((call) => call[1])).toEqual([bigDocs.length]);
  });
});
