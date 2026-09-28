import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildSearchIndexSync, isStopWordOnlyQuery, searchAtlas, tokenizeField, tokenizeQuery } from '../search-index';
import { isStopword, withoutStopwords } from '../stop-words';
import { createDoc, createFixtureTree } from './fixtures';

describe('withoutStopwords', () => {
  it('drops function words from a conversational query', () => {
    expect(withoutStopwords(['how', 'are', 'delegates', 'compensated'])).toEqual(['delegates', 'compensated']);
  });

  it('leaves a terse query untouched', () => {
    expect(withoutStopwords(['delegate', 'compensation'])).toEqual(['delegate', 'compensation']);
  });

  it('never treats the trailing token as a stop word while it is still being typed', () => {
    // "the" in "in the" may be on its way to "in theory": keep it as a prefix.
    expect(withoutStopwords(['in', 'the'], true)).toEqual(['the']);
    expect(withoutStopwords(['what', 'is', 'the'], true)).toEqual(['the']);
    expect(withoutStopwords(['the'], true)).toEqual(['the']);
  });

  it('drops a completed query that is nothing but function words', () => {
    // Once every word is complete and all are stop words there is nothing to search for;
    // searching the stop words themselves could only return prefix-expansion noise.
    expect(withoutStopwords(['what', 'is', 'the'])).toEqual([]);
    expect(withoutStopwords(['of', 'the'])).toEqual([]);
  });

  it('handles an empty term list', () => {
    expect(withoutStopwords([])).toEqual([]);
  });

  it('does not drop words that carry legal meaning', () => {
    // "not", "all" and "may" change what a governance sentence means.
    expect(withoutStopwords(['not', 'all', 'may'])).toEqual(['not', 'all', 'may']);
    expect(isStopword('not')).toBe(false);
    expect(isStopword('all')).toBe(false);
    expect(isStopword('may')).toBe(false);
  });
});

describe('SEARCH-05 acceptance criteria', () => {
  it('drops function words at index time', () => {
    expect(tokenizeField('the budget of the scope', 'content')).toEqual(['budget', 'scope']);
  });

  it('drops function words at query time', () => {
    // Stemmed, per SEARCH-05's sibling change: the contract is that the article is gone.
    expect(tokenizeQuery('the facilitator')).toEqual(tokenizeQuery('facilitator'));
  });

  it('returns the same results and order for "the facilitator" as for "facilitator"', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const index = buildSearchIndexSync(docs);
    const withArticle = searchAtlas(index, 'the facilitator').hits.map((hit) => hit.id);
    const without = searchAtlas(index, 'facilitator').hits.map((hit) => hit.id);
    expect(withArticle).toEqual(without);
    expect(withArticle.length).toBeGreaterThan(0);
  });

  it('keeps a trailing stop word as a prefix, and drops it once a space completes it', () => {
    expect(tokenizeQuery('the')).toEqual(['the']);
    expect(tokenizeQuery('in the')).toEqual(['the']);
    expect(tokenizeQuery('in the ')).toEqual([]);
    expect(isStopWordOnlyQuery('in the ')).toBe(true);
    expect(isStopWordOnlyQuery('in the')).toBe(false);
    expect(isStopWordOnlyQuery('   ')).toBe(false);
  });

  it('lets "in the" reach "in theory" as it is typed, and returns nothing once completed', () => {
    const docs = flattenAtlasDocuments([
      createDoc('Scope', 'C.1', 'Alignment', 'In theory every actor is aligned.'),
      createDoc('Scope', 'C.2', 'Budgets', 'Funds are allocated in the cycle.'),
    ]);
    const index = buildSearchIndexSync(docs);
    const docNosFor = (query: string) => searchAtlas(index, query).hits.map((hit) => docs[hit.id].doc_no);

    expect(docNosFor('in the')).toEqual(['C.1']);
    expect(docNosFor('in theo')).toEqual(['C.1']);
    expect(docNosFor('in theory')).toEqual(['C.1']);
    expect(docNosFor('in the ')).toEqual([]);
    expect(docNosFor('of the ')).toEqual([]);
  });

  it('no longer returns documents merely because they contain the article', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const index = buildSearchIndexSync(docs);
    // Fixture content contains "The governance process of the Atlas." — searching the
    // article must not retrieve it, because `the` is not in the index at all.
    const hits = searchAtlas(index, 'the').hits.map((hit) => docs[hit.id].doc_no);
    expect(hits).not.toContain('A.1');
  });
});
