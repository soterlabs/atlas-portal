import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildTitleKeywordIndex, suggestTitleKeywords, titleTokens } from '../title-keywords';
import { createDoc } from './fixtures';

// checklist appears in 3 titles, spark in 3, vault in 2; hub/overview/rules once.
// "The … of …" carries stopwords; Société carries an accent to fold.
const tree = [
  createDoc('Scope', 'A.1', 'The Checklist Hub', 'Hub text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'Spark Checklist', 'Spark checklist text.'),
      createDoc('Article', 'A.1.2', 'Vault Checklist', 'Vault checklist text.'),
      createDoc('Article', 'A.1.3', 'Spark Vault Rules', 'Rules text.'),
    ],
  }),
  createDoc('Scope', 'A.2', 'Spark Overview of Société', 'Overview text.'),
];
const documents = flattenAtlasDocuments(tree);
const index = buildTitleKeywordIndex(documents);

describe('titleTokens (SEARCH-57)', () => {
  it('folds, drops stopwords and short tokens, deduplicates', () => {
    expect(titleTokens('The Société of X Société')).toEqual(['societe']);
  });
});

describe('buildTitleKeywordIndex (SEARCH-57)', () => {
  it('orders tokens by title count descending, then alphabetically', () => {
    expect(index.tokens).toEqual(['checklist', 'spark', 'vault', 'hub', 'overview', 'rules', 'societe']);
  });

  it('postings count titles, not occurrences', () => {
    expect(index.postings.get('checklist')).toHaveLength(3);
    expect(index.postings.get('spark')).toHaveLength(3);
  });
});

describe('suggestTitleKeywords (SEARCH-57)', () => {
  it('an empty partial lists every keyword with its plain title frequency', () => {
    expect(suggestTitleKeywords(index, '')).toEqual([
      { keyword: 'checklist', count: 3 },
      { keyword: 'spark', count: 3 },
      { keyword: 'vault', count: 2 },
      { keyword: 'hub', count: 1 },
      { keyword: 'overview', count: 1 },
      { keyword: 'rules', count: 1 },
      { keyword: 'societe', count: 1 },
    ]);
  });

  it('prefix-filters on the folded partial', () => {
    expect(suggestTitleKeywords(index, 'ch')).toEqual([{ keyword: 'checklist', count: 3 }]);
    expect(suggestTitleKeywords(index, 'Socié')).toEqual([{ keyword: 'societe', count: 1 }]);
    expect(suggestTitleKeywords(index, 'zzz')).toEqual([]);
  });

  it('context terms turn counts into titles-containing-all and drop themselves', () => {
    const suggestions = suggestTitleKeywords(index, '', ['checklist']);
    // Only co-occurring keywords survive; overview/rules/societe share no title with checklist.
    expect(suggestions).toEqual([
      { keyword: 'hub', count: 1 },
      { keyword: 'spark', count: 1 },
      { keyword: 'vault', count: 1 },
    ]);
  });

  it('two context terms intersect further', () => {
    expect(suggestTitleKeywords(index, '', ['spark', 'vault'])).toEqual([{ keyword: 'rules', count: 1 }]);
  });

  it('a context term absent from every title empties the suggestions', () => {
    expect(suggestTitleKeywords(index, '', ['nonexistent'])).toEqual([]);
  });
});
