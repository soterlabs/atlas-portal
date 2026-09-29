/**
 * SEARCH-57: the title-keyword index behind `title:` suggestions. Titles have no
 * tree to drill into (unlike `in:`), but they share a small keyword vocabulary
 * (~2,300 tokens over 11,456 documents), so the suggestion unit is the title
 * keyword, ranked by how many titles contain it. When the query already carries
 * other title-restricted terms, the rank becomes a co-occurrence count: titles
 * containing the candidate AND every context term — the second-keyword case falls
 * out of the same rule.
 *
 * Counts are verbatim-token counts over folded names; the engine can only match
 * MORE via stemming/prefix/fuzzy, so a displayed count is a lower bound on what
 * `title:keyword` returns (the SEARCH-52 honest-count rule).
 *
 * Deterministic and self-updating with the Atlas: pure functions, built once per
 * document tree like the entity lexicon.
 */
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { isStopword } from './stop-words';

const NAME_SEPARATOR = /[^\p{L}\p{N}]+/u;

export interface TitleKeywordIndex {
  /** token → ids of documents whose folded name contains the token (each sorted ascending). */
  postings: Map<string, number[]>;
  /** All tokens sorted by title count descending, then alphabetically. */
  tokens: string[];
}

/** Tokenizes one document name the way the index does: folded words, no stopwords. */
export function titleTokens(name: string): string[] {
  return [
    ...new Set(
      foldText(name)
        .split(NAME_SEPARATOR)
        .filter((token) => token.length >= 2 && !isStopword(token)),
    ),
  ];
}

export function buildTitleKeywordIndex(documents: FlatAtlasDocument[]): TitleKeywordIndex {
  const postings = new Map<string, number[]>();
  for (const document of documents) {
    for (const token of titleTokens(document.name)) {
      const list = postings.get(token);
      if (list) list.push(document.id);
      else postings.set(token, [document.id]);
    }
  }
  const tokens = [...postings.keys()].sort((a, b) => {
    const byCount = postings.get(b)!.length - postings.get(a)!.length;
    return byCount !== 0 ? byCount : a < b ? -1 : 1;
  });
  return { postings, tokens };
}

export interface TitleKeywordSuggestion {
  keyword: string;
  /** Number of titles containing the keyword and every context term. */
  count: number;
}

function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

/**
 * Suggestions for a trailing `title:<partial>`: keywords prefix-matching the folded
 * partial (all keywords when it is empty), counted against the context — the other
 * title-restricted terms already in the query. A context term is looked up as a
 * verbatim token; a context term absent from every title empties all intersections.
 * Zero-count candidates and the context terms themselves are dropped. With no
 * context the counts are plain title frequencies in the pre-sorted token order.
 */
export function suggestTitleKeywords(
  index: TitleKeywordIndex,
  partial: string,
  contextTerms: string[] = [],
): TitleKeywordSuggestion[] {
  const needle = foldText(partial);
  const context = new Set(contextTerms.map(foldText));
  context.delete('');
  const contextPostings: number[][] = [];
  for (const term of context) {
    const list = index.postings.get(term);
    if (!list) return [];
    contextPostings.push(list);
  }

  const suggestions: TitleKeywordSuggestion[] = [];
  for (const keyword of index.tokens) {
    if (needle && !keyword.startsWith(needle)) continue;
    if (context.has(keyword)) continue;
    let ids = index.postings.get(keyword)!;
    for (const list of contextPostings) {
      ids = intersect(ids, list);
      if (ids.length === 0) break;
    }
    if (ids.length === 0) continue;
    suggestions.push({ keyword, count: ids.length });
  }
  if (contextPostings.length > 0) {
    suggestions.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.keyword < b.keyword ? -1 : 1));
  }
  return suggestions;
}
