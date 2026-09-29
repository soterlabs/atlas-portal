/**
 * SEARCH-70: what "Exact matches" means — the adopted policy (2026-09-10),
 * amended by SEARCH-81 (2026-09-11): exact means the query words all occur
 * close together — within the window an ordered skip-gram with gap ≤ k would
 * have spanned, but in ANY order — inside ONE field of the ORIGINAL Atlas
 * text (title, body, or extras; never across their seams). Generated search
 * text never counts toward exactness; every approximation the engine admits
 * (stemming, typo repair, prefix, generated-text-supplied words, scattered
 * placement) belongs to Partial matches instead.
 *
 * Word forms ARE tolerated inside the window (the accepted knob setting): the
 * comparison is stem-level with compound pieces, so "duties" sits in an exact
 * window where the text says "duty", and "offchain" where it says "off-chain".
 *
 * Display-layer only: these functions re-categorize rows for presentation; the
 * engine's retrieval and ranking are untouched.
 */
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { MAX_COMPOUND_PARTS, compoundPieces, stemTerm, tokenizeQueryUnstemmed } from './search-index';

/** Maximum words allowed between neighbouring query words (accepted default). */
export const EXACT_SKIP_GRAM_K = 2;
/** Minimum share of query words a Partial row must match to show unrevealed. */
export const PARTIAL_COVERAGE_FLOOR = 0.5;

/** The stems one document WORD answers for: its own stem plus compound pieces. */
function wordStems(token: string): Set<string> {
  const set = new Set<string>([stemTerm(token)]);
  for (const piece of compoundPieces(token)) set.add(stemTerm(piece));
  return set;
}

/**
 * The stem a run of adjacent words answers for when read as one word
 * ("off" + "chain" → the stem of "offchain"; up to MAX_COMPOUND_PARTS words, so
 * "collateral-onboarding-checklist" is found too). Shared with the highlighter
 * (SEARCH-77), so what counts as exact and what gets marked cannot drift apart.
 */
export function joinedRunStem(words: string[]): string {
  return stemTerm(words.join(''));
}

function textWordSets(text: string): Array<Set<string>> {
  const tokens = foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  const sets = tokens.map(wordStems);
  // A hyphenated document word ("off-chain", "collateral-onboarding-checklist")
  // folds into two or three words; each joined stem is added at the first word's
  // position so a query typed solid finds it.
  for (let index = 0; index < tokens.length; index++) {
    for (let length = 2; length <= MAX_COMPOUND_PARTS && index + length <= tokens.length; length++) {
      sets[index].add(joinedRunStem(tokens.slice(index, index + length)));
    }
  }
  return sets;
}

/** Query text → the stems the exact test looks for, in order. */
export function queryStems(query: string): string[] {
  return tokenizeQueryUnstemmed(query).map((token) => stemTerm(token));
}

/**
 * SEARCH-81: true when every DISTINCT stem occurs within one window of
 * `m + (m−1)·k` consecutive words — the exact span an ordered chain with gap
 * ≤ k was allowed, with the order requirement dropped (the adopted option).
 * Duplicate query words collapse to their distinct stems: a deliberate
 * simplification, since word positions answer for several stems at once
 * (compound pieces, pair joins) and exact multiplicity matching would buy
 * complexity for no real query. A single stem reduces to presence.
 */
export function hasWordWindow(words: Array<Set<string>>, stems: string[], k: number): boolean {
  const needed = [...new Set(stems)];
  if (needed.length === 0) return false;
  const width = needed.length + (needed.length - 1) * k;

  // Every (position, stem) hit in text order, then the classic sliding window:
  // advance the right edge, evict hits that fell out of the window, and stop
  // as soon as every needed stem is covered at once.
  const hits: Array<{ position: number; stem: string }> = [];
  words.forEach((set, position) => {
    for (const stem of needed) if (set.has(stem)) hits.push({ position, stem });
  });
  const counts = new Map<string, number>();
  let covered = 0;
  let left = 0;
  for (const hit of hits) {
    counts.set(hit.stem, (counts.get(hit.stem) ?? 0) + 1);
    if (counts.get(hit.stem) === 1) covered++;
    while (hits[left].position <= hit.position - width) {
      const dropped = hits[left++];
      const remaining = counts.get(dropped.stem)! - 1;
      counts.set(dropped.stem, remaining);
      if (remaining === 0) covered--;
    }
    if (covered === needed.length) return true;
  }
  return false;
}

// The folded word sets of a document's own text, one array per FIELD (title,
// body, extras) so a window can never span a field seam — cached per document
// object: the exact test runs over up to ~100 rows per query and must not
// refold text on every keystroke's render.
const ownTextCache = new WeakMap<FlatAtlasDocument, Array<Array<Set<string>>>>();

/**
 * The exact test (SEARCH-70, amended by SEARCH-81): the query's words within
 * one unordered window (span as for gap ≤ k), inside a single field of the
 * document's own text — title, body, extras; generated text excluded.
 */
export function isExactMatch(stems: string[], document: FlatAtlasDocument, k: number = EXACT_SKIP_GRAM_K): boolean {
  if (stems.length === 0) return false;
  let fields = ownTextCache.get(document);
  if (!fields) {
    fields = [document.name, document.content, document.extras ?? '']
      .filter((text) => text.length > 0)
      .map(textWordSets);
    ownTextCache.set(document, fields);
  }
  return fields.some((words) => hasWordWindow(words, stems, k));
}

/**
 * Share of the distinct query stems a row's matched terms cover — the Partial
 * quality bar. `matchedTerms` are the engine's matched document-side terms
 * (`hit.terms`), compared at stem level.
 */
export function coverageOf(stems: string[], matchedTerms: string[]): number {
  const distinct = new Set(stems);
  if (distinct.size === 0) return 0;
  const matched = new Set(matchedTerms.flatMap((term) => [...wordStems(term)]));
  let covered = 0;
  for (const stem of distinct) if (matched.has(stem)) covered++;
  return covered / distinct.size;
}
