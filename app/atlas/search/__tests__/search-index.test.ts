import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import {
  buildSearchIndexSync,
  depthBoost,
  loadSerializedSearchIndex,
  searchAtlas,
  searchAtlasTiered,
  tokenizeField,
  tokenizeQuery,
} from '../search-index';
import { createDoc, createFixtureTree } from './fixtures';

describe('tokenizeField', () => {
  it('emits a document number as one whole token', () => {
    expect(tokenizeField('A.1.2.3', 'doc_no')).toEqual(['a.1.2.3']);
  });

  it('splits prose into lowercase word tokens, indexing each word and its stem', () => {
    // Both forms are indexed: the stem carries morphology, the original carries typo
    // tolerance (a misspelling stems badly, so it can only reach the original).
    expect(tokenizeField('Aligned Delegates receive pay', 'content')).toEqual([
      'aligned',
      'align',
      'delegates',
      'deleg',
      'receive',
      'receiv',
      'pay',
      'pai',
    ]);
  });

  it('emits a doc-number reference in prose whole, without splitting it into parts', () => {
    // The whole token is what answers a cross-reference search: `a.1.2` prefix-matches
    // `a.1.2.3` wherever it is cited. Splitting also indexed bare digits as searchable
    // terms, which matched nothing the whole token did not already match.
    expect(tokenizeField('see A.1.2 now', 'content')).toEqual(['see', 'a.1.2', 'now']);
  });

  it('still finds a document that cites a number, via the whole token', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const index = buildSearchIndexSync(docs);
    // A.1.6.5 contains "See A.1.6.4 ..." in its content.
    const hits = searchAtlas(index, 'a.1.6.4').hits.map((hit) => docs[hit.id].doc_no);
    expect(hits).toContain('A.1.6.4');
    expect(hits).toContain('A.1.6.5');
  });

  it('drops sentence-final periods rather than treating them as doc numbers', () => {
    expect(tokenizeField('the end.', 'content')).toEqual(['end']);
  });

  it('drops function words at index time so they cannot skew ranking', () => {
    // Many Atlas titles begin with "The"; the name boost on `the` otherwise outranked
    // genuine matches. Stop words are absent from the index entirely (SEARCH-05).
    // "scenario" stems to itself, so it is emitted once; "facilitator" yields both forms.
    expect(tokenizeField('The Facilitator Scenario', 'name')).toEqual(['facilitator', 'facilit', 'scenario']);
  });

  it('emits a hyphenated compound as its parts and as one joined word', () => {
    // 168 documents write "off-chain"; 33 write "offchain". Both spellings must reach
    // each other, so the joined form is indexed alongside the parts (SEARCH-07).
    // Each word yields itself then its stem; the compound yields its parts then the join.
    expect(tokenizeField('off-chain parameters', 'content')).toEqual([
      'off',
      'chain',
      'offchain',
      'parameters',
      'paramet',
    ]);
  });

  it('joins alphanumeric compounds people type without the hyphen', () => {
    expect(tokenizeField('ERC-4626 vault', 'content')).toEqual(['erc', '4626', 'erc4626', 'vault']);
  });

  it('does not join an all-digit compound', () => {
    // "2023-06-08" would otherwise index as "20230608", a token nobody types.
    expect(tokenizeField('2023-06-08', 'content')).toEqual(['2023', '06', '08']);
  });

  it('does not join identifiers such as UUIDs', () => {
    const tokens = tokenizeField('see c2abdd22-fe0f-489e-b281-450e066db701 here', 'content');
    expect(tokens).not.toContain('c2abdd22fe0f489eb281450e066db701');
    expect(tokens).toContain('c2abdd22');
  });

  it('treats a non-breaking hyphen like an ordinary one, and dashes as separators', () => {
    expect(tokenizeField('off‑chain', 'content')).toEqual(['off', 'chain', 'offchain']);
    expect(tokenizeField('budget — approved', 'content')).toEqual(['budget', 'approved', 'approv']);
  });

  it('leaves a document number alone even though it contains no hyphen', () => {
    expect(tokenizeField('see A.1.6.4 now', 'content')).toEqual(['see', 'a.1.6.4', 'now']);
  });

  it('folds accented letters instead of splitting on them', () => {
    expect(tokenizeField('Société Générale', 'content')).toEqual(['societe', 'societ', 'generale', 'general']);
  });

  it('keeps non-Latin letters as word characters', () => {
    expect(tokenizeField('Ключевые слова', 'content')).toEqual(['ключевые', 'слова']);
  });
});

describe('tokenizeQuery', () => {
  it('keeps a document-number query whole', () => {
    expect(tokenizeQuery('A.1.2')).toEqual(['a.1.2']);
  });

  it('splits a multi-word query into stemmed terms', () => {
    expect(tokenizeQuery('delegate compensation')).toEqual(['deleg', 'compens']);
  });

  it('drops function words so conversational phrasing reaches the same documents', () => {
    expect(tokenizeQuery('how are delegates compensated')).toEqual(['deleg', 'compens']);
    expect(tokenizeQuery('delegate compensation')).toEqual(['deleg', 'compens']);
  });

  it('keeps only the trailing token of an all-function-word query, as a prefix in progress', () => {
    expect(tokenizeQuery('what is the')).toEqual(['the']);
    expect(tokenizeQuery('what is the ')).toEqual([]);
  });

  it('returns nothing for punctuation-only input', () => {
    expect(tokenizeQuery('   ...  ')).toEqual([]);
  });

  it('turns a hyphenated query term into its joined form only', () => {
    // Under AND, emitting `off` and `chain` too would exclude documents that write
    // "offchain": they have neither part as a token. The joined form reaches both.
    expect(tokenizeQuery('off-chain parameters')).toEqual(['offchain', 'paramet']);
    expect(tokenizeQuery('off-chain')).toEqual(tokenizeQuery('offchain'));
  });

  it('keeps a hyphen being typed as a prefix in progress', () => {
    expect(tokenizeQuery('off-')).toEqual(['off']);
  });

  it('treats accented and unaccented spellings as the same query', () => {
    expect(tokenizeQuery('Société')).toEqual(tokenizeQuery('Societe'));
  });
});

describe('short-term guards', () => {
  const docs = flattenAtlasDocuments(createFixtureTree());
  const index = buildSearchIndexSync(docs);

  it('does not prefix-match on a single character', () => {
    // `a` prefix-matches most of the corpus: 49 ms against a 10 ms budget on the real
    // Atlas. Two characters is the shortest prefix carrying any signal.
    const wide = searchAtlas(index, 'a');
    const narrow = searchAtlas(index, 'go');
    expect(wide.total).toBeLessThan(docs.length);
    expect(narrow.total).toBeGreaterThan(0);
  });

  it('still prefix-matches from two characters', () => {
    expect(searchAtlas(index, 'gov').hits.length).toBeGreaterThan(0);
  });

  it('does not fuzzy-match terms shorter than four characters', () => {
    // At three characters an edit budget of 1 matches a large slice of the dictionary.
    const hits = searchAtlas(index, 'xyz').hits;
    expect(hits).toEqual([]);
  });

  it('still tolerates typos from four characters up', () => {
    expect(searchAtlas(index, 'governanc').hits.length).toBeGreaterThan(0);
  });
});

describe('depthBoost', () => {
  it('favours shallower documents', () => {
    expect(depthBoost(0)).toBeGreaterThan(depthBoost(1));
    expect(depthBoost(1)).toBeGreaterThan(depthBoost(2));
  });

  it('flattens out at depth 4 and beyond', () => {
    expect(depthBoost(4)).toBe(1);
    expect(depthBoost(9)).toBe(1);
  });

  it('is neutral when depth is unknown', () => {
    expect(depthBoost(undefined)).toBe(1);
  });
});

describe('searchAtlas', () => {
  const docs = flattenAtlasDocuments(createFixtureTree());
  const index = buildSearchIndexSync(docs);
  const docNosFor = (query: string, options?: Parameters<typeof searchAtlas>[2]) =>
    searchAtlas(index, query, options).hits.map((hit) => docs[hit.id].doc_no);

  it('matches multi-word queries whose terms are not contiguous', () => {
    expect(docNosFor('delegate compensation')).toContain('A.1.6.4');
  });

  it('matches terms spread across different fields', () => {
    // "scope" is in the name, "budget" is in the content.
    expect(docNosFor('scope budget')).toContain('A.2');
  });

  it('is order-independent', () => {
    expect(docNosFor('scope budget')).toEqual(docNosFor('budget scope'));
  });

  it('ranks documents matching every term above documents matching only some', () => {
    // "kickbacks" and "treasury" never co-occur, so nothing satisfies the strict pass;
    // the relaxed pass still surfaces documents matching either term (see the two-pass
    // contract in searchAtlas) rather than leaving the user with nothing.
    const both = docNosFor('kickbacks prohibited');
    expect(both[0]).toBe('A.1.6.5');

    const neither = docNosFor('kickbacks treasury');
    expect(neither.length).toBeGreaterThan(0);
    expect(neither).toContain('A.1.6.5');
  });

  it('tolerates typos', () => {
    expect(docNosFor('faciliator')).toContain('A.1.7');
  });

  it('matches prefixes as you type', () => {
    expect(docNosFor('gover')).toContain('A.1');
  });

  it('returns a document-number subtree for a partial number', () => {
    const results = docNosFor('a.1.6');
    expect(results).toEqual(expect.arrayContaining(['A.1.6', 'A.1.6.4', 'A.1.6.5']));
  });

  it('ranks an exact document-number match first', () => {
    expect(docNosFor('a.1.6.4')[0]).toBe('A.1.6.4');
  });

  it('does not fuzzy-match document numbers onto their siblings', () => {
    // A.1.7 is one edit away from A.1.6 but is not part of that subtree.
    const results = docNosFor('a.1.6');
    expect(results[0]).toBe('A.1.6');
    expect(results).not.toContain('A.1.7');
    expect(results.sort()).toEqual(['A.1.6', 'A.1.6.4', 'A.1.6.5']);
  });

  it('finds both spellings of a compound from either spelling of the query', () => {
    const flat = flattenAtlasDocuments([
      createDoc('Scope', 'D.1', 'Off-chain Operational Parameters', 'Set off-chain by the operator.'),
      createDoc('Scope', 'D.2', 'Offchain Vote', 'The offchain process for votes.'),
      createDoc('Scope', 'D.3', 'Onchain Parameters', 'Set onchain by governance.'),
    ]);
    const compoundIndex = buildSearchIndexSync(flat);
    const docNos = (query: string) => searchAtlas(compoundIndex, query).hits.map((hit) => flat[hit.id].doc_no);

    // Both spellings are strict matches and rank first; "onchain" is only ever a fuzzy
    // neighbour in the relaxed tail (strict results always outrank relaxed ones).
    expect(docNos('off-chain').slice(0, 2).sort()).toEqual(['D.1', 'D.2']);
    expect(docNos('offchain').slice(0, 2).sort()).toEqual(['D.1', 'D.2']);
    // With three documents IDF is degenerate, so the fuzzy neighbour can tie the strict
    // match; the corpus-level ordering ("Off-chain Operational Parameters" first for
    // `offchain parameters`, 288 hits for either spelling) is verified against the live
    // corpus, not here. What a small fixture can assert: the compound match
    // outranks the document that lacks the second term.
    const ranked = docNos('offchain parameters');
    expect(ranked.indexOf('D.1')).toBeLessThan(ranked.indexOf('D.2'));
  });

  it('finds accented words by their accented, unaccented and prefix forms', () => {
    expect(docNosFor('Société')).toContain('A.1.8');
    expect(docNosFor('societe')).toContain('A.1.8');
    expect(docNosFor('soci')).toContain('A.1.8');
  });

  it('still tolerates typos in ordinary words', () => {
    expect(docNosFor('compensaton')).toContain('A.1.6.4');
  });

  it('breaks score ties by tree order', () => {
    const siblings = Array.from({ length: 12 }, (_, i) =>
      createDoc('Article', `B.1.${i + 1}`, 'Article', 'Identical body.'),
    );
    const flat = flattenAtlasDocuments([createDoc('Scope', 'B.1', 'Scope', 'Root.', { articles: siblings })]);
    const hits = searchAtlas(buildSearchIndexSync(flat), 'b.1.').hits;
    expect(hits.map((hit) => flat[hit.id].doc_no)).toEqual(['B.1', ...siblings.map((doc) => doc.doc_no)]);
  });

  it('finds documents that cite a document number, not just the document itself', () => {
    // A.1.6.5 contains "See A.1.6.4 ..." in its content.
    expect(docNosFor('a.1.6.4')).toContain('A.1.6.5');
  });

  it('ranks a name match above a content-only match', () => {
    const results = docNosFor('compensation');
    expect(results.indexOf('A.1.6.4')).toBeLessThan(results.indexOf('A.1.6.5'));
  });

  it('ranks a shallower document above a deeper one at similar relevance', () => {
    const results = docNosFor('budget');
    expect(results.indexOf('A.2')).toBeLessThan(results.indexOf('A.1.6'));
  });

  it('matches extra fields', () => {
    expect(docNosFor('treasury allocation')).toContain('A.2.1');
  });

  it('narrows results by type', () => {
    expect(docNosFor('budget', { types: ['Scope'] })).toEqual(['A.2']);
  });

  it('applies the result cap after filtering, and reports the unclipped total', () => {
    // "delegates" appears across several fixture documents; "the" no longer would, since
    // stop words are not indexed.
    const clipped = searchAtlas(index, 'delegates', { limit: 1 });
    expect(clipped.hits).toHaveLength(1);
    expect(clipped.total).toBeGreaterThan(1);
  });

  it('treats a punctuation-only query as empty', () => {
    expect(searchAtlas(index, '  ... ')).toEqual({ hits: [], total: 0 });
  });

  it('never returns documents that have no doc_no', () => {
    expect(docNosFor('orphan annotation')).toEqual([]);
  });

  it('reports which fields a query matched in', () => {
    const { hits } = searchAtlas(index, 'treasury allocation');
    expect(hits[0].fields).toContain('extras');
  });

  it('reports a name match as such', () => {
    const { hits } = searchAtlas(index, 'kickbacks');
    expect(hits[0].fields).toContain('name');
  });
});

describe('includeId ancestry filtering (SEARCH-08)', () => {
  // Fixture where the strict pass alone exceeds a small limit, so filtering inside the
  // pass is observable: with post-hoc filtering, an excluded doc would consume the cap.
  const docs = [
    { doc_no: 'A.1', name: 'Budget Rules', content: 'budget rules for spark' },
    { doc_no: 'A.2', name: 'Budget Rules', content: 'budget rules for grove' },
    { doc_no: 'A.3', name: 'Budget Rules', content: 'budget rules for keel' },
    { doc_no: 'A.4', name: 'Budget Notes', content: 'notes mentioning budget' },
  ].map((doc, id) => ({
    id,
    type: 'Core',
    extras: '',
    breadcrumb: id === 3 ? ['Other'] : ['Scope', 'Primes'],
    depth: 2,
    source: {} as never,
    ...doc,
  }));
  const index = buildSearchIndexSync(docs as never);

  it('applies inside the pass, so the cap counts only included documents', () => {
    const underPrimes = new Set([0, 1, 2]);
    const { hits, total } = searchAtlas(index, 'budget rules', {
      limit: 2,
      includeId: (id) => underPrimes.has(id),
    });
    expect(hits.map((hit) => hit.id).every((id) => underPrimes.has(id))).toBe(true);
    expect(hits).toHaveLength(2);
    expect(total).toBe(3); // A.4 is excluded from the count as well as the page
  });

  it('filters the relaxed passes too', () => {
    // 'budget notes' strictly matches only A.4; excluded, the relaxed tail must also
    // respect the predicate rather than resurrect it.
    const { hits } = searchAtlas(index, 'budget notes', { includeId: (id) => id !== 3 });
    expect(hits.map((hit) => hit.id)).not.toContain(3);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('composes with the type filter and keeps results unique', () => {
    const { hits } = searchAtlas(index, 'budget', { types: ['Core'], includeId: (id) => id !== 1 });
    const ids = hits.map((hit) => hit.id);
    expect(ids).not.toContain(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('changes nothing when omitted', () => {
    const withOut = searchAtlas(index, 'budget rules');
    const withAll = searchAtlas(index, 'budget rules', { includeId: () => true });
    expect(withAll.hits.map((hit) => hit.id)).toEqual(withOut.hits.map((hit) => hit.id));
  });
});

describe('SEARCH-73: typo repair only for unknown words', () => {
  const tree = [
    createDoc('Scope', 'S.1', 'Slopes', 'The slippery slope argument.', {
      articles: [
        createDoc('Article', 'S.1.1', 'Scope Overview', 'The scope of this document is broad.'),
        createDoc('Article', 'S.1.2', 'Compensation', 'Delegate compensation rules.'),
      ],
    }),
  ];
  const documents = flattenAtlasDocuments(tree);
  const index = buildSearchIndexSync(documents);
  const nameOf = (hit: { id: number }) => documents[hit.id].name;

  it('a known word is never treated as a typo of another (slope ≠ scope)', () => {
    const tiers = searchAtlasTiered(index, 'slippery slope', { limit: 100 });
    const names = [...tiers.strict, ...tiers.relaxed].map(nameOf);
    expect(names).toContain('Slopes');
    expect(names).not.toContain('Scope Overview');
  });

  it('an unknown word still repairs (compensaton → compensation)', () => {
    const tiers = searchAtlasTiered(index, 'compensaton', { limit: 100 });
    expect(tiers.strict.map(nameOf)).toContain('Compensation');
  });

  it('the guard behaves identically on a rehydrated prebuilt index', () => {
    const rehydrated = loadSerializedSearchIndex(JSON.stringify(index));
    const guarded = searchAtlasTiered(rehydrated, 'slippery slope', { limit: 100 });
    expect([...guarded.strict, ...guarded.relaxed].map(nameOf)).not.toContain('Scope Overview');
    const repaired = searchAtlasTiered(rehydrated, 'compensaton', { limit: 100 });
    expect(repaired.strict.map(nameOf)).toContain('Compensation');
  });
});
