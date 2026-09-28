import { describe, expect, it } from 'vitest';
import {
  type CensusDocument,
  buildCensus,
  crossCheckFamily,
  identicalBodyFamilies,
  jaccard,
  nearDuplicateFamilies,
  normalizeText,
  sameNameMixedParentFamilies,
  sameNameSameParentFamilies,
  wordShingles,
} from '../census';

function doc(overrides: Partial<CensusDocument> & { doc_no: string }): CensusDocument {
  return { name: 'Doc', type: 'Core', breadcrumb: ['Scope', 'Article'], content: '', ...overrides };
}

const SHARED =
  'The operator must call the controller contract to execute the transfer of the underlying asset ' +
  'to the destination domain after burning on the source domain and then confirm that the message ' +
  'has been attested by the transmitter before minting the corresponding amount for the recipient ' +
  'address on the destination chain and finally record the transaction identifier in the log ';
// One word changed in a ~64-word body flips 3 of ~62 shingles: Jaccard ≈ 59/65 ≈ 0.91.
const LONG_BODY = SHARED + 'for later reconciliation by the operations team.';
const LONG_BODY_ONE_WORD = SHARED + 'for later reconciliation by the operations crew.';

describe('normalizeText', () => {
  it('folds case, whitespace and unicode normalisation into one canonical form', () => {
    expect(normalizeText('  The\n\nOperator\tMUST ')).toBe('the operator must');
    expect(normalizeText('Café')).toBe(normalizeText('Café'));
    expect(normalizeText('   ')).toBe('');
  });
});

describe('wordShingles and jaccard', () => {
  it('builds word 3-shingles', () => {
    expect(wordShingles('a b c d')).toEqual(new Set(['a b c', 'b c d']));
    expect(wordShingles('a b').size).toBe(0);
  });

  it('jaccard is 1 for identical sets, 0 for disjoint, and symmetric in between', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['x', 'y', 'w']);
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, new Set(['q']))).toBe(0);
    expect(jaccard(a, b)).toBeCloseTo(2 / 4);
    expect(jaccard(b, a)).toBeCloseTo(2 / 4);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe('identicalBodyFamilies', () => {
  it('groups byte-equal normalised bodies and ignores empty and unique ones', () => {
    const families = identicalBodyFamilies([
      doc({ doc_no: 'A.1', content: 'Shared body.' }),
      doc({ doc_no: 'A.2', content: '  shared BODY. ' }),
      doc({ doc_no: 'A.3', content: 'Different.' }),
      doc({ doc_no: 'A.4', content: '' }),
      doc({ doc_no: 'A.5', content: '' }),
    ]);
    expect(families).toEqual([{ docNos: ['A.1', 'A.2'], bodyChars: 12, name: 'Doc' }]);
  });

  it('omits the shared name when members are named differently', () => {
    const families = identicalBodyFamilies([
      doc({ doc_no: 'A.1', name: 'One', content: 'Same.' }),
      doc({ doc_no: 'A.2', name: 'Two', content: 'Same.' }),
    ]);
    expect(families[0].name).toBeUndefined();
  });
});

describe('nearDuplicateFamilies', () => {
  it('joins bodies differing by one word and excludes short and dissimilar bodies', () => {
    const families = nearDuplicateFamilies([
      doc({ doc_no: 'A.1', content: LONG_BODY }),
      doc({ doc_no: 'A.2', content: LONG_BODY_ONE_WORD }),
      doc({ doc_no: 'A.3', content: 'too short to participate in shingling at all' }),
      doc({
        doc_no: 'A.4',
        content:
          'A completely unrelated body about delegate compensation cycles and buffers, long enough to shingle properly here.',
      }),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0].docNos).toEqual(['A.1', 'A.2']);
  });

  it('is a superset of identical-body families for bodies long enough to shingle', () => {
    const families = nearDuplicateFamilies([
      doc({ doc_no: 'A.1', content: LONG_BODY }),
      doc({ doc_no: 'A.2', content: LONG_BODY }),
    ]);
    expect(families).toEqual([{ docNos: ['A.1', 'A.2'], bodyChars: normalizeText(LONG_BODY).length, name: 'Doc' }]);
  });

  it('respects the threshold: a shared prefix with a different long tail does not qualify', () => {
    const families = nearDuplicateFamilies([
      doc({ doc_no: 'A.1', content: LONG_BODY }),
      doc({
        doc_no: 'A.2',
        content:
          'The operator must call the controller contract to execute the transfer and afterwards ' +
          'notify the governance facilitator through the designated communication channel within ' +
          'one business day including the amounts moved and the block number of the transaction.',
      }),
    ]);
    expect(families).toHaveLength(0);
  });
});

describe('same-name families', () => {
  const docs = [
    doc({ doc_no: 'A.1', name: 'Maximum Exposure', breadcrumb: ['S', 'Off-chain Operational Parameters'] }),
    doc({ doc_no: 'A.2', name: 'Maximum Exposure', breadcrumb: ['S', 'Off-chain Operational Parameters'] }),
    doc({ doc_no: 'B.1', name: 'Parameters', breadcrumb: ['S', 'Grove'] }),
    doc({ doc_no: 'B.2', name: 'Parameters', breadcrumb: ['S', 'Keel'] }),
    doc({ doc_no: 'C.1', name: 'Unique', breadcrumb: ['S', 'X'] }),
  ];

  it('template families require the parent name to match too', () => {
    expect(sameNameSameParentFamilies(docs)).toEqual([{ docNos: ['A.1', 'A.2'], name: 'Maximum Exposure' }]);
  });

  it('mixed-parent families span at least two parent names', () => {
    expect(sameNameMixedParentFamilies(docs)).toEqual([{ docNos: ['B.1', 'B.2'], name: 'Parameters' }]);
  });
});

describe('buildCensus and crossCheckFamily', () => {
  const docs = [
    doc({ doc_no: 'A.1', name: 'Bridge', content: LONG_BODY }),
    doc({ doc_no: 'A.2', name: 'Bridge', content: LONG_BODY }),
    doc({ doc_no: 'B.1', name: 'Other', content: 'Unique body.' }),
    doc({ doc_no: 'C.1', name: 'Empty', content: '' }),
  ];

  it('summarises counts, size distribution and type concentration', () => {
    const census = buildCensus(docs);
    expect(census.documents).toBe(4);
    expect(census.emptyBodies).toBe(1);
    expect(census.identicalBody.summary).toEqual({
      families: 1,
      documents: 2,
      sizeDistribution: { 2: 1 },
      documentsByType: { Core: 2 },
    });
    expect(census.nearDuplicate.summary.families).toBe(1);
  });

  it('cross-checks a judged family against every census definition', () => {
    const census = buildCensus(docs);
    const check = crossCheckFamily('F99', ['A.1'], census);
    expect(check.matchedBy).toContain('identical-body');
    expect(check.missingFromJudged).toEqual(['A.2']);
    expect(check.judgedNotInCensusFamily).toEqual([]);

    const orphan = crossCheckFamily('F98', ['B.1'], census);
    expect(orphan.matchedBy).toEqual([]);
    expect(orphan.judgedNotInCensusFamily).toEqual(['B.1']);
  });
});
