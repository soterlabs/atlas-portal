/**
 * SEARCH-16: no document may appear twice in any result list, from any
 * configuration. The engine's multi-pass search (strict AND, then two relaxed OR passes)
 * deduplicates by document id; these tests pin that invariant under the configurations
 * that exist today, so fusion (SEARCH-21) and post-processing (SEARCH-22) inherit an
 * enforced contract rather than an assumption. The graded runner independently throws on
 * a duplicate doc_no at evaluation time.
 */
import { describe, expect, it } from 'vitest';
import type { FlatAtlasDocument } from '../flatten-documents';
import { DEFAULT_RESULT_LIMIT, buildSearchIndexSync, searchAtlas } from '../search-index';

function makeDoc(id: number, overrides: Partial<FlatAtlasDocument>): FlatAtlasDocument {
  return {
    id,
    doc_no: `A.${id}`,
    name: 'Document',
    type: 'Core',
    content: '',
    extras: '',
    breadcrumb: [],
    depth: 2,
    source: {} as FlatAtlasDocument['source'],
    ...overrides,
  } as FlatAtlasDocument;
}

/**
 * A corpus engineered so every pass has something to add for the probe queries:
 * strict AND matches, stemmed OR matches, and unstemmed (typo-recovery) OR matches.
 */
const docs: FlatAtlasDocument[] = [
  makeDoc(0, { name: 'Facilitator Removal', content: 'The facilitator removal process is defined herein.' }),
  makeDoc(1, { name: 'Facilitators', content: 'Facilitators are removed by adjudication.' }),
  makeDoc(2, { name: 'Removal', content: 'Removal of collateral types.' }),
  makeDoc(3, { name: 'Facilitator', content: 'A facilitator interprets the Atlas.' }),
  makeDoc(4, { name: 'Delegate Compensation', content: 'Delegates are compensated monthly.', type: 'Section' }),
  makeDoc(5, { name: 'Compensation', content: 'Compensation cycles for delegates.', type: 'Section' }),
  makeDoc(6, { name: 'Unrelated', content: 'Liquidation thresholds for vaults.' }),
];

const index = buildSearchIndexSync(docs);

const PROBE_QUERIES = [
  'facilitator removal', // strict matches plus relaxed tail
  'faciliator removal', // typo: unstemmed relaxed pass contributes
  'delegate compensation',
  'compensated', // stem shared across documents
  'removal facilitator delegate', // OR-heavy: no strict match at all
];

function hitIds(query: string, options?: Parameters<typeof searchAtlas>[2]): number[] {
  return searchAtlas(index, query, options).hits.map((hit) => hit.id);
}

describe('result-list uniqueness invariant', () => {
  it('never returns the same document twice, for any probe query', () => {
    for (const query of PROBE_QUERIES) {
      const ids = hitIds(query);
      expect(ids.length, query).toBeGreaterThan(0);
      expect(new Set(ids).size, query).toBe(ids.length);
    }
  });

  it('holds under type filtering', () => {
    for (const query of PROBE_QUERIES) {
      for (const types of [['Core'], ['Section'], ['Core', 'Section']]) {
        const ids = hitIds(query, { types });
        expect(new Set(ids).size, `${query} types=${types.join()}`).toBe(ids.length);
      }
    }
  });

  it('holds under a limit smaller than the strict pass and at the default limit', () => {
    for (const query of PROBE_QUERIES) {
      for (const limit of [1, 2, DEFAULT_RESULT_LIMIT]) {
        const ids = hitIds(query, { limit });
        expect(new Set(ids).size, `${query} limit=${limit}`).toBe(ids.length);
        expect(ids.length, `${query} limit=${limit}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('distinct ids imply distinct doc_nos while the corpus keeps doc_no unique', () => {
    // The census CLI asserts corpus-level doc_no uniqueness on every run; given that,
    // id-level deduplication is doc_no-level deduplication. This test documents the
    // dependency rather than hiding it inside the engine.
    const docNos = docs.map((doc) => doc.doc_no);
    expect(new Set(docNos).size).toBe(docNos.length);
    for (const query of PROBE_QUERIES) {
      const resultDocNos = hitIds(query).map((id) => docs[id].doc_no);
      expect(new Set(resultDocNos).size, query).toBe(resultDocNos.length);
    }
  });
});
