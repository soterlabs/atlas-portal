import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AbbreviationCuration,
  type AbbreviationEntry,
  applyCuration,
  expandQueryTokens,
  harvestAbbreviations,
  initialsMatch,
} from '../abbreviations';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildSearchIndexSync, searchAtlas } from '../search-index';
import { createDoc } from './fixtures';

describe('initialsMatch (SEARCH-55)', () => {
  it('matches word initials in order, skipping connectives', () => {
    expect(initialsMatch('CRR', 'Capital Ratio Requirement')).toBe(true);
    expect(initialsMatch('GSM', 'Governance Security Module')).toBe(true);
    expect(initialsMatch('LRSC', 'List of Registered Spell Checklists')).toBe(true);
  });

  it('rejects mismatched or over-long phrases', () => {
    expect(initialsMatch('CRR', 'Capital Requirement')).toBe(false);
    expect(initialsMatch('CRR', 'Capital Ratio Requirement Extra')).toBe(false);
  });
});

const tree = [
  createDoc('Scope', 'A.1', 'Stability', 'The Capital Ratio Requirement (CRR) governs solvency. See CRR details.', {
    articles: [
      createDoc('Core', 'A.1.1', 'Capital Ratio Requirement', 'The requirement body.'),
      // Name initialism grounded by usage: "DSR" occurs in text below.
      createDoc('Core', 'A.1.2', 'Dai Savings Rate', 'Rates accrue. The DSR updates weekly.'),
      // Ungrounded initialism: "BSW" never occurs anywhere — must not be harvested.
      createDoc('Core', 'A.1.3', 'Budget Spending Window', 'Spending happens within the window.'),
      // Stray parenthetical that is not a definition: initials do not match.
      createDoc('Core', 'A.1.4', 'Notes', 'Various fees (ETC) are listed elsewhere.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);
const table = harvestAbbreviations(documents);

describe('harvestAbbreviations (SEARCH-55)', () => {
  it('harvests verified parenthetical definitions', () => {
    expect(table.get('crr')).toMatchObject({ phrase: 'capital ratio requirement', source: 'parenthetical' });
  });

  it('harvests name initialisms only when the corpus actually uses the acronym', () => {
    expect(table.get('dsr')).toMatchObject({ phrase: 'dai savings rate', source: 'name-initialism' });
    expect(table.has('bsw')).toBe(false); // never used in text
  });

  it('rejects stray parentheses whose initials do not match', () => {
    expect(table.has('etc')).toBe(false);
  });
});

describe('applyCuration (SEARCH-82)', () => {
  const harvested = (): Map<string, AbbreviationEntry> =>
    new Map([
      ['sta', { acronym: 'sta', phrase: 'spell team anonymity', source: 'name-initialism' as const }],
      ['url', { acronym: 'url', phrase: 'usds rate limit', source: 'name-initialism' as const }],
      ['crr', { acronym: 'crr', phrase: 'capital ratio requirement', source: 'parenthetical' as const }],
    ]);

  it('excludes, overrides, and adds — folded, with the curated source', () => {
    const curated = applyCuration(harvested(), {
      exclude: ['URL'],
      override: { STA: 'Stability Scope' },
      add: { AD: 'Aligned Delegate', dpau: 'diamond pau' },
    });
    expect(curated.has('url')).toBe(false);
    expect(curated.get('sta')).toEqual({ acronym: 'sta', phrases: ['stability scope'], source: 'curated' });
    expect(curated.get('ad')).toEqual({ acronym: 'ad', phrases: ['aligned delegate'], source: 'curated' });
    expect(curated.get('dpau')).toEqual({ acronym: 'dpau', phrases: ['diamond pau'], source: 'curated' });
    // Untouched harvested entries survive, as single-meaning lists.
    expect(curated.get('crr')).toMatchObject({ phrases: ['capital ratio requirement'], source: 'parenthetical' });
  });

  it('a value may be a list of meanings — kept in order, deduplicated strictly (SEARCH-83)', () => {
    const curated = applyCuration(harvested(), {
      add: { SR: ['Staking Rewards', 'Savings Rate'] },
    });
    expect(curated.get('sr')).toEqual({
      acronym: 'sr',
      phrases: ['staking rewards', 'savings rate'],
      source: 'curated',
    });
    expect(() => applyCuration(harvested(), { add: { zz: ['same phrase', 'Same  Phrase'] } })).toThrow(
      /invalid curation entry/,
    );
    expect(() => applyCuration(harvested(), { add: { zz: [] } })).toThrow(/invalid curation entry/);
  });

  it('is strict, so the tracked file cannot rot as the corpus moves', () => {
    expect(() => applyCuration(harvested(), { exclude: ['gone'] })).toThrow(/no such acronym/);
    expect(() => applyCuration(harvested(), { override: { gone: 'some phrase' } })).toThrow(/move it to add/);
    expect(() => applyCuration(harvested(), { add: { crr: 'other phrase' } })).toThrow(/move it to override/);
    // Junk entries fail loudly rather than shipping.
    expect(() => applyCuration(harvested(), { add: { 'a b': 'x y' } })).toThrow(/invalid curation entry/);
    expect(() => applyCuration(harvested(), { add: { zz: 'oneword' } })).toThrow(/invalid curation entry/);
  });

  it('the real curation file applies cleanly to a table shaped like the harvest', () => {
    // Guards the tracked JSON itself: shape and folding rules hold.
    const real = JSON.parse(readFileSync('data/abbreviation-curation.json', 'utf8')) as AbbreviationCuration;
    const table = new Map<string, AbbreviationEntry>(
      [...(real.exclude ?? []), ...Object.keys(real.override ?? {})].map((acronym) => [
        acronym,
        { acronym, phrase: 'placeholder phrase', source: 'name-initialism' as const },
      ]),
    );
    const curated = applyCuration(table, real);
    expect(curated.get('sta')?.phrases).toEqual(['stability scope']);
    expect(curated.get('sup')?.phrases).toEqual(['support scope']);
    expect(curated.get('ad')?.phrases).toEqual(['aligned delegate']);
    expect(curated.get('dpau')?.phrases).toEqual(['diamond pau']);
    expect(curated.has('url')).toBe(false);
    // SEARCH-83: the ambiguous entries carry every meaning, in order.
    expect(curated.get('sr')?.phrases).toEqual(['staking rewards', 'savings rate']);
    expect(curated.get('dc')?.phrases).toEqual(['debt ceiling', 'delegate contract']);
    expect(curated.get('sp')?.phrases).toEqual(['sky protocol', 'sky primitives']);
  });
});

describe('expandQueryTokens (SEARCH-55)', () => {
  const lookup = (token: string) => table.get(token) ?? null;

  it('replaces the mapped acronym token with its phrase', () => {
    const expanded = expandQueryTokens(['crr', 'osero'], lookup);
    expect(expanded?.query).toBe('capital ratio requirement osero');
    expect(expanded?.entry.acronym).toBe('crr');
  });

  it('returns null when nothing maps', () => {
    expect(expandQueryTokens(['governance', 'process'], lookup)).toBeNull();
    expect(expandQueryTokens([], lookup)).toBeNull();
  });
});

describe('engine integration: the expanded companion route (SEARCH-55)', () => {
  const engineTree = [
    createDoc('Scope', 'E.1', 'Solvency Ledger', 'The Capital Ratio Requirement (CRR) applies to primes.', {
      articles: [
        createDoc('Core', 'E.2', 'Capital Ratio Requirement', 'The capital ratio requirement governs solvency.'),
        createDoc('Core', 'E.3', 'Fee Notes', 'Fees settle quarterly.'),
      ],
    }),
  ];
  const engineDocs = flattenAtlasDocuments(engineTree);
  const engineIndex = buildSearchIndexSync(engineDocs);
  const engineTable = harvestAbbreviations(engineDocs);
  const abbreviationOf = (token: string) => engineTable.get(token) ?? null;
  const docNo = (id: number) => engineDocs[id].doc_no;

  it('appends phrase matches below the literal results, never displacing them', () => {
    const { hits, abbreviation } = searchAtlas(engineIndex, 'crr', { abbreviationOf });
    expect(docNo(hits[0].id)).toBe('E.1'); // the document literally containing CRR stays first
    const expanded = hits.filter((hit) => hit.provenance === 'expanded');
    expect(expanded.map((hit) => docNo(hit.id))).toEqual(['E.2']);
    expect(hits.findIndex((hit) => hit.provenance === 'expanded')).toBeGreaterThan(0);
    expect(abbreviation).toEqual({ acronym: 'crr', phrase: 'capital ratio requirement' });
  });

  it('recovers the spelled-out document in a scope that lacks the acronym (the crr Osero shape)', () => {
    const scoped = searchAtlas(engineIndex, 'crr', {
      abbreviationOf,
      includeId: (id) => docNo(id) !== 'E.1', // the scope contains only spelled-out documents
    });
    expect(scoped.hits.some((hit) => docNo(hit.id) === 'E.2' && hit.provenance === 'expanded')).toBe(true);
    expect(scoped.abbreviation).toBeDefined();
  });

  it('does nothing without a lookup and nothing for unmapped queries', () => {
    expect(searchAtlas(engineIndex, 'crr', {}).abbreviation).toBeUndefined();
    expect(searchAtlas(engineIndex, 'solvency', { abbreviationOf }).abbreviation).toBeUndefined();
  });

  it('a weak rung guess yields to the expanded row for the same document (hybrid path)', async () => {
    const { searchAtlasTiered } = await import('../search-index');
    const { composeHybrid } = await import('../hybrid-search');
    const tiers = searchAtlasTiered(engineIndex, 'crr', { abbreviationOf, limit: 100 });
    const expandedId = tiers.expanded![0].id;
    // The dense tier guesses the same document below the weak line: the expanded row
    // must win (visible, honest label) instead of hiding behind the weak reveal.
    const results = composeHybrid(tiers, [{ row: expandedId, docNo: docNo(expandedId), score: 0.3 }], { limit: 100 });
    const row = results.hits.find((hit) => hit.id === expandedId);
    expect(row?.provenance).toBe('expanded');
    expect(row?.weak).toBeUndefined();
    expect(results.abbreviation).toBeDefined();
  });
});
