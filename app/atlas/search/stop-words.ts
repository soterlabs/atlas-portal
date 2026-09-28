/**
 * English function words dropped at index time and at query time (SEARCH-05).
 *
 * At query time this stops a conversational query from demanding that every filler word
 * co-occur: under AND semantics "how are delegates compensated" otherwise requires `how`
 * AND `are`, and the four-way intersection is empty even though `are` alone appears in
 * 3,088 documents. At index time it keeps the `name ×3` boost on "The" from reordering
 * results, and shrinks the index.
 *
 * Deliberately small: only words that carry no topical meaning in Atlas queries. Words
 * like `not`, `all` or `may` are excluded because they change legal meaning.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'shall',
  'should',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * Drops function words from a query's terms.
 *
 * Only *completed* words can be stop words. While the user is typing, the last token is
 * a prefix in progress, not a word: `the` in "in the" may be on its way to "in theory".
 * With `lastIsPrefix` the final term is therefore always kept, so it can prefix-match
 * real indexed words (`the` → `theory`, `theoretical`). Once the user types a space after
 * it, it is a completed word and is dropped like any other.
 *
 * A query consisting only of completed stop words yields no terms — and so no results —
 * rather than falling back to searching the stop words themselves: they are not in the
 * index, so that search could only ever return prefix-expansion noise (`of the` → every
 * document with an `of…` and a `the…` word).
 */
export function withoutStopwords(terms: string[], lastIsPrefix = false): string[] {
  return terms.filter((term, index) => (lastIsPrefix && index === terms.length - 1) || !STOPWORDS.has(term));
}

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}
