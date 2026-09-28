import { describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildSearchIndexSync, searchAtlas } from '../search-index';
import { MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO, mapAtlasVocabulary } from '../vocabulary';
import { createDoc } from './fixtures';

describe('mapAtlasVocabulary (SEARCH-09)', () => {
  it.each([
    ['maximum cap', 'maximum tolerance', 'cap', 10],
    ['maximum caps', 'maximum tolerance', 'caps', 10],
    ['exposure limit', 'exposure tolerance', 'limit', 20],
    ['show EXPOSURE LIMITS now', 'show EXPOSURE tolerance now', 'LIMITS', 20],
  ])('maps the measured reader phrase %s', (query, retrievalQuery, readerTerm, promotionRank) => {
    expect(mapAtlasVocabulary(query)).toMatchObject({
      originalQuery: query,
      retrievalQuery,
      targetDocNo: MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO,
      promotionRank,
      replacements: [{ readerTerm, atlasTerm: 'tolerance' }],
    });
  });

  it.each([
    'max cap',
    'maximum limit',
    'supply cap',
    'borrow cap',
    'rate limit',
    'exposure tolerance',
    'recapitalization limit',
    'maximum capstone',
    'pre-exposure limit',
    'maximum cap-limit',
  ])('leaves the literal Atlas concept %s unchanged', (query) => expect(mapAtlasVocabulary(query)).toBeNull());

  it('discloses a repeated reader word once, still mapping every occurrence', () => {
    expect(mapAtlasVocabulary('maximum cap and exposure cap')).toMatchObject({
      retrievalQuery: 'maximum tolerance and exposure tolerance',
      promotionRank: 10,
      replacements: [{ readerTerm: 'cap', atlasTerm: 'tolerance' }],
    });
  });

  it('still recognizes measured phrases next to ordinary punctuation', () => {
    expect(mapAtlasVocabulary('(maximum cap), exposure limits.')).toMatchObject({
      retrievalQuery: '(maximum tolerance), exposure tolerance.',
      promotionRank: 10,
      replacements: [
        { readerTerm: 'cap', atlasTerm: 'tolerance' },
        { readerTerm: 'limits', atlasTerm: 'tolerance' },
      ],
    });
  });
});

describe('Atlas-vocabulary retrieval (SEARCH-09)', () => {
  const targetDocNo = MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO;
  const documents = flattenAtlasDocuments([
    createDoc(
      'Scope',
      targetDocNo,
      'Maximum Exposure Tolerance',
      'The maximum exposure tolerance permits interest accrual.',
    ),
    createDoc('Scope', 'B.2', 'Supply Cap Definition', 'The supply cap is 100 million units.'),
    createDoc('Scope', 'B.3', 'Borrow Cap Definition', 'The borrow cap is 50 million units.'),
    createDoc('Scope', 'B.4', 'Max Cap Definition', 'The maxCap parameter defines the maximum cap value.'),
    ...Array.from({ length: 25 }, (_, index) =>
      createDoc(
        'Scope',
        `B.${index + 5}`,
        `Literal Exposure Limit ${index + 1}`,
        `Maximum cap and exposure limit rule ${index + 1}.`,
      ),
    ),
  ]);
  const index = buildSearchIndexSync(documents);
  const ranked = (query: string, applyVocabulary?: boolean) => {
    const results = searchAtlas(index, query, { applyVocabulary });
    return {
      results,
      docNos: results.hits.map((hit) => documents[hit.id].doc_no),
    };
  };

  it.each([
    ['maximum cap', 10],
    ['exposure cap', 20],
    ['exposure limit', 20],
  ])('promotes only the tolerance rule to the measured boundary for %s', (query, expectedRank) => {
    const literal = ranked(query, false);
    const { results, docNos } = ranked(query);
    const targetRank = docNos.indexOf(targetDocNo) + 1;
    expect(targetRank).toBe(expectedRank);
    expect(targetRank).toBeLessThan(literal.docNos.indexOf(targetDocNo) + 1);
    expect(results.vocabulary?.retrievalQuery).toContain('tolerance');
    expect(results.hits.filter((hit) => hit.vocabulary).map((hit) => documents[hit.id].doc_no)).toEqual([targetDocNo]);

    // Removing the one promoted target recovers the literal ranking exactly: no other
    // document is added, dropped, or reordered.
    expect(docNos.filter((docNo) => docNo !== targetDocNo)).toEqual(
      literal.docNos.filter((docNo) => docNo !== targetDocNo),
    );
  });

  it.each([
    ['maximum cap', 10],
    ['exposure cap', 20],
    ['exposure limit', 20],
  ])('does not touch the literal top window above its boundary for %s', (query, expectedRank) => {
    const literal = ranked(query, false).docNos;
    const promoted = ranked(query).docNos;
    expect(promoted.slice(0, expectedRank - 1)).toEqual(literal.slice(0, expectedRank - 1));
  });

  it('keeps max cap byte-identical because it is an Atlas-native term', () => {
    const mapped = ranked('max cap');
    const literal = ranked('max cap', false);
    expect(mapped).toEqual(literal);
    expect(mapped.docNos[0]).toBe('B.4');
  });

  it('does not report a translation when the target already satisfies the boundary', () => {
    const smallDocuments = flattenAtlasDocuments([
      createDoc('Scope', targetDocNo, 'Maximum Exposure Tolerance', 'Maximum exposure tolerance.'),
      createDoc('Scope', 'C.2', 'Maximum Cap', 'Maximum cap.'),
    ]);
    const smallIndex = buildSearchIndexSync(smallDocuments);
    const searchSpy = vi.spyOn(smallIndex, 'search');
    const results = searchAtlas(smallIndex, 'maximum cap');

    // The target is already second, inside the rank-10 boundary, so the engine leaves
    // the literal ordering and metadata alone.
    expect(results.vocabulary).toBeUndefined();
    expect(results.hits.some((hit) => hit.vocabulary)).toBe(false);
    expect(searchSpy.mock.calls.some(([query]) => query === 'maximum tolerance')).toBe(false);
  });

  it('keeps the adjudicated target first when it was already first', () => {
    const direct = ranked('exposure tolerance');
    expect(direct.docNos[0]).toBe(targetDocNo);
    expect(direct.results.vocabulary).toBeUndefined();
    expect(direct.results.hits[0].vocabulary).toBeUndefined();
  });

  it.each([
    ['supply cap', 'B.2'],
    ['borrow cap', 'B.3'],
  ])('does not change the ranking for %s', (query, target) => {
    const mapped = ranked(query);
    const literal = ranked(query, false);
    expect(mapped).toEqual(literal);
    expect(mapped.docNos[0]).toBe(target);
  });

  it('can be disabled for explicit literal-search operators', () => {
    const promoted = ranked('maximum cap');
    const literal = ranked('maximum cap', false);
    expect(literal.results.vocabulary).toBeUndefined();
    expect(literal.docNos.indexOf(targetDocNo)).toBeGreaterThan(promoted.docNos.indexOf(targetDocNo));
  });

  it('does not claim an intervention when the promoted result is outside a short page', () => {
    const results = searchAtlas(index, 'maximum cap', { limit: 5 });
    expect(results.hits).toHaveLength(5);
    expect(results.hits.some((hit) => hit.vocabulary)).toBe(false);
    expect(results.vocabulary).toBeUndefined();
  });

  it('preserves ordering and truthful metadata across every page limit around the boundary', () => {
    for (let limit = 0; limit <= 30; limit += 1) {
      const literal = searchAtlas(index, 'maximum cap', { limit, applyVocabulary: false });
      const candidate = searchAtlas(index, 'maximum cap', { limit });
      const literalIds = literal.hits.map((hit) => hit.id);
      const candidateIds = candidate.hits.map((hit) => hit.id);
      const targetId = documents.find((document) => document.doc_no === targetDocNo)!.id;
      const candidateWithoutTarget = candidateIds.filter((id) => id !== targetId);

      expect(new Set(candidateIds).size, `duplicate at limit ${limit}`).toBe(candidateIds.length);
      expect(candidateWithoutTarget, `non-target order at limit ${limit}`).toEqual(
        literalIds.filter((id) => id !== targetId).slice(0, candidateWithoutTarget.length),
      );
      expect(Boolean(candidate.vocabulary), `result metadata at limit ${limit}`).toBe(candidateIds.includes(targetId));
      expect(
        candidate.hits.some((hit) => hit.vocabulary),
        `hit metadata at limit ${limit}`,
      ).toBe(candidateIds.includes(targetId));
      expect(candidate.total, `candidate total at limit ${limit}`).toBeGreaterThanOrEqual(literal.total);
      expect(candidate.total, `candidate total at limit ${limit}`).toBeLessThanOrEqual(literal.total + 1);
    }
  });

  it('honours an active scope predicate instead of injecting the target through it', () => {
    const withoutTarget = (id: number) => documents[id].doc_no !== targetDocNo;
    const mapped = searchAtlas(index, 'maximum cap', { includeId: withoutTarget });
    const literal = searchAtlas(index, 'maximum cap', { includeId: withoutTarget, applyVocabulary: false });

    expect(mapped).toEqual(literal);
    expect(mapped.hits.some((hit) => documents[hit.id].doc_no === targetDocNo)).toBe(false);
    expect(mapped.vocabulary).toBeUndefined();
  });

  it('honours field restrictions instead of injecting a target that did not match there', () => {
    const mapped = searchAtlas(index, 'maximum cap', { fields: ['doc_no'] });
    const literal = searchAtlas(index, 'maximum cap', { fields: ['doc_no'], applyVocabulary: false });

    expect(mapped).toEqual(literal);
    expect(mapped.vocabulary).toBeUndefined();
  });

  it('honours type filters instead of injecting a target of another type', () => {
    const smallDocuments = flattenAtlasDocuments([
      createDoc('Scope', targetDocNo, 'Maximum Exposure Tolerance', 'Maximum exposure tolerance.'),
      ...Array.from({ length: 12 }, (_, index) =>
        createDoc('Article', `E.${index + 2}`, `Maximum Cap ${index + 1}`, `Maximum cap ${index + 1}.`),
      ),
    ]);
    const smallIndex = buildSearchIndexSync(smallDocuments);
    const mapped = searchAtlas(smallIndex, 'maximum cap', { types: ['Article'] });
    const literal = searchAtlas(smallIndex, 'maximum cap', { types: ['Article'], applyVocabulary: false });

    expect(mapped).toEqual(literal);
    expect(mapped.hits.every((hit) => smallDocuments[hit.id].type === 'Article')).toBe(true);
    expect(mapped.vocabulary).toBeUndefined();
  });

  it('never injects a different document merely because it matches the companion query', () => {
    const decoyDocNo = 'C.2';
    const smallDocuments = flattenAtlasDocuments([
      createDoc('Scope', targetDocNo, 'Maximum Exposure Tolerance', 'Maximum exposure tolerance.'),
      createDoc('Scope', decoyDocNo, 'Maximum Tolerance Overview', 'Maximum tolerance.'),
      ...Array.from({ length: 105 }, (_, index) =>
        createDoc('Scope', `C.${index + 3}`, `Maximum Cap ${index + 1}`, `Maximum cap ${index + 1}.`),
      ),
    ]);
    const smallIndex = buildSearchIndexSync(smallDocuments);
    const results = searchAtlas(smallIndex, 'maximum cap');
    const docNos = results.hits.map((hit) => smallDocuments[hit.id].doc_no);

    expect(docNos).toContain(targetDocNo);
    expect(docNos).not.toContain(decoyDocNo);
    expect(results.hits.filter((hit) => hit.vocabulary)).toHaveLength(1);
  });

  it('resolves the immutable target id only once per index', () => {
    const smallDocuments = flattenAtlasDocuments([
      createDoc('Scope', targetDocNo, 'Maximum Exposure Tolerance', 'Maximum exposure tolerance.'),
      ...Array.from({ length: 25 }, (_, index) =>
        createDoc('Scope', `D.${index + 2}`, `Maximum Cap ${index + 1}`, `Maximum cap ${index + 1}.`),
      ),
    ]);
    const smallIndex = buildSearchIndexSync(smallDocuments);
    const searchSpy = vi.spyOn(smallIndex, 'search');

    searchAtlas(smallIndex, 'maximum cap');
    searchAtlas(smallIndex, 'exposure limit');

    expect(searchSpy.mock.calls.filter(([query]) => query === targetDocNo)).toHaveLength(1);
  });
});
