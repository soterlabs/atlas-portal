import { describe, expect, it } from 'vitest';
import { EXACT_SKIP_GRAM_K, coverageOf, isExactMatch, queryStems } from '../exactness';
import { flattenAtlasDocuments } from '../flatten-documents';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Rules', 'Rules text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'Governance Process', 'The governance approval process is described here.'),
      createDoc(
        'Article',
        'A.1.2',
        'Scattered',
        'Governance is one thing. Twenty words of filler follow before anything else about how a certain review process runs.',
      ),
      createDoc('Article', 'A.1.3', 'Reversed', 'The process of governance in general.'),
      createDoc('Article', 'A.1.4', 'Word Forms', 'Facilitators handle removals of delegates.'),
      createDoc('Article', 'A.1.5', 'Compound', 'All off-chain parameters live here.'),
      createDoc('Article', 'A.1.9', 'Triple', 'Complete the collateral-onboarding-checklist first.'),
      createDoc('Article', 'A.1.6', 'Accents', 'La Société Générale opère ici.'),
      // The SEARCH-81 seam shape: "atlas" ends the title, "spirit" opens the
      // body — adjacent in concatenation, never together inside one field.
      createDoc('Article', 'A.1.7', 'About The Atlas', 'Spirit matters here.'),
      createDoc('Article', 'A.1.8', 'Spirit Of The Atlas', 'Body without the words together.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);
const byNo = (docNo: string) => documents.find((document) => document.doc_no === docNo)!;

describe('isExactMatch (SEARCH-70/81: unordered window, k=2, per-field, word-form tolerant)', () => {
  it('accepts the phrase and small gaps; scattered words stay out', () => {
    const stems = queryStems('governance process');
    expect(isExactMatch(stems, byNo('A.1.1'))).toBe(true); // 'governance approval process' (gap 1)
    expect(isExactMatch(stems, byNo('A.1.2'))).toBe(false); // far apart
  });

  it('accepts any word order inside the window (SEARCH-81)', () => {
    // 'The process of governance in general' — reversed, span 3 ≤ window 4.
    expect(isExactMatch(queryStems('governance process'), byNo('A.1.3'))).toBe(true);
    // Three words, fully shuffled, still within the three-word window (7).
    expect(isExactMatch(queryStems('general governance process'), byNo('A.1.3'))).toBe(true);
    // The motivating case: the title "Spirit Of The Atlas" alone makes
    // "atlas spirit" exact.
    expect(isExactMatch(queryStems('atlas spirit'), byNo('A.1.8'))).toBe(true);
  });

  it('a window never spans the title/body seam (SEARCH-81)', () => {
    // Title ends "…Atlas", body begins "Spirit …": adjacent only in
    // concatenation. Neither field holds both words, so this is not exact.
    expect(isExactMatch(queryStems('atlas spirit'), byNo('A.1.7'))).toBe(false);
  });

  it('tolerates word forms and compounds inside the phrase', () => {
    expect(isExactMatch(queryStems('facilitator removal'), byNo('A.1.4'))).toBe(true); // facilitators … removals (gap 1)
    expect(isExactMatch(queryStems('offchain parameters'), byNo('A.1.5'))).toBe(true); // off-chain
  });

  it('a three-part compound typed solid or hyphenated is an exact match (bug 3)', () => {
    expect(isExactMatch(queryStems('collateral-onboarding-checklist'), byNo('A.1.9'))).toBe(true);
    expect(isExactMatch(queryStems('collateralonboardingchecklist'), byNo('A.1.9'))).toBe(true);
  });

  it('folds case and accents; a single word reduces to presence', () => {
    expect(isExactMatch(queryStems('societe generale'), byNo('A.1.6'))).toBe(true);
    expect(isExactMatch(queryStems('governance'), byNo('A.1.2'))).toBe(true);
    expect(isExactMatch(queryStems('missing'), byNo('A.1.1'))).toBe(false);
  });

  it('generated search text never counts: only name/content/extras are scanned', () => {
    const flat = flattenAtlasDocuments(tree, { 'A.1.1': 'delegate compensation appears only here' });
    const withExpansion = flat.find((document) => document.doc_no === 'A.1.1')!;
    expect(withExpansion.expansion).toContain('delegate compensation');
    expect(isExactMatch(queryStems('delegate compensation'), withExpansion)).toBe(false);
  });

  it('the gap knob is honoured', () => {
    const stems = queryStems('governance described');
    // 'governance approval process is described' — gaps of 3 between the words.
    expect(isExactMatch(stems, byNo('A.1.1'), EXACT_SKIP_GRAM_K)).toBe(false);
    expect(isExactMatch(stems, byNo('A.1.1'), 3)).toBe(true);
  });
});

describe('coverageOf (SEARCH-70 Partial floor)', () => {
  it('is the matched share of distinct query stems, word-form tolerant', () => {
    const stems = queryStems('alpha beta gamma');
    expect(coverageOf(stems, ['alphas'])).toBeCloseTo(1 / 3);
    expect(coverageOf(stems, ['alpha', 'beta'])).toBeCloseTo(2 / 3);
    expect(coverageOf(stems, ['alpha', 'betas', 'gamma'])).toBe(1);
    expect(coverageOf(stems, [])).toBe(0);
  });
});
