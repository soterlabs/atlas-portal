/**
 * Context policy for the answer feature (SEARCH-47): how much of each retrieved
 * document the model sees. `full-document` is the shipped SEARCH-25 behaviour;
 * `bounded-snippet` bounds each document to verbatim windows around the question's
 * terms; `citations-only` sends identifiers and names with no text at all.
 *
 * zvec-grep (insight I-2) defaults its agents to citations-only because they can then
 * OPEN the cited file; this route is single-shot with no tool loop, so citations-only
 * cannot produce a verifiable quote and exists here only as a measured control arm.
 *
 * Every excerpt is a contiguous verbatim slice of the original document, so a quote
 * copied from an excerpt still verifies against the full corpus text (verify.ts).
 * Boundary markers live on their own header lines, never inside the sliced text.
 */
import { splitHighlight } from '@/app/atlas/search/highlight';
import { tokenizeQueryUnstemmed } from '@/app/atlas/search/search-index';

export type AnswerContextPolicy = 'full-document' | 'bounded-snippet' | 'citations-only';

export const ANSWER_CONTEXT_POLICIES: readonly AnswerContextPolicy[] = [
  'full-document',
  'bounded-snippet',
  'citations-only',
];

export const DEFAULT_ANSWER_CONTEXT_POLICY: AnswerContextPolicy = 'full-document';

/**
 * A document at or under the budget is passed whole (and renders exactly as the
 * full-document policy would), so bounding only ever touches the longer documents.
 * Chosen from a measured sweep over the dev-split retrievals (2026-09-04): 700/250
 * trimmed only 3.4% of document text (windows merge to near-full coverage on this
 * corpus's short documents); 300/80 trims 32.3% and still keeps a full clause of
 * context on each side of a matched term.
 *
 * VERDICT (2026-09-04): the measured arm is a closed negative on this corpus — the
 * 6.5% token saving cost three answers and 7.4 pts of qualifier retention, so
 * `bounded-snippet` and `citations-only` exist as measured instruments only and the
 * default stays `full-document`. Re-measure before enabling any other policy.
 */
export const SNIPPET_BUDGET_CHARS = 300;
/** Window half-width around each matched term. */
export const SNIPPET_WINDOW_PAD = 80;

/**
 * A mis-set environment value must not take the route down or silently invent a new
 * behaviour: anything unrecognised is the shipped default.
 */
export function parseAnswerContextPolicy(value: string | undefined): AnswerContextPolicy {
  return (ANSWER_CONTEXT_POLICIES as readonly string[]).includes(value ?? '')
    ? (value as AnswerContextPolicy)
    : DEFAULT_ANSWER_CONTEXT_POLICY;
}

export interface BoundedExcerpts {
  /** Contiguous verbatim slices of the source text, in document order. */
  excerpts: string[];
  /** False when the whole document fit inside the budget. */
  truncated: boolean;
}

/** [start, end) offsets of every query-term match, via the highlighter's matcher. */
function matchRanges(text: string, terms: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const segment of splitHighlight(text, terms)) {
    if (segment.match) ranges.push([cursor, cursor + segment.text.length]);
    cursor += segment.text.length;
  }
  return ranges;
}

/** Shrinks a slice inward to whole words; a partial edge word carries no meaning. */
function snapToWords(text: string, start: number, end: number): [number, number] {
  let from = start;
  let to = end;
  if (from > 0 && !/\s/.test(text[from - 1])) {
    const space = text.slice(from, to).search(/\s/);
    if (space > 0) from += space + 1;
  }
  if (to < text.length && !/\s/.test(text[to])) {
    const space = text.slice(from, to).match(/\s\S*$/);
    if (space?.index !== undefined) to = from + space.index;
  }
  return from < to ? [from, to] : [start, end];
}

/**
 * Bounds one document to verbatim windows around the query's terms: a window of
 * ±`pad` characters around every match, overlapping windows merged, windows taken in
 * document order until the budget is spent (the first window always fits). A document
 * with no match contributes its head, which mirrors the modal's snippet fallback.
 */
export function boundToExcerpts(
  text: string,
  query: string,
  budget: number = SNIPPET_BUDGET_CHARS,
  pad: number = SNIPPET_WINDOW_PAD,
): BoundedExcerpts {
  if (text.length <= budget) return { excerpts: [text], truncated: false };

  const terms = tokenizeQueryUnstemmed(query);
  const ranges = terms.length > 0 ? matchRanges(text, terms) : [];
  if (ranges.length === 0) {
    const [from, to] = snapToWords(text, 0, budget);
    return { excerpts: [text.slice(from, to)], truncated: true };
  }

  const windows: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const from = Math.max(0, start - pad);
    const to = Math.min(text.length, end + pad);
    const last = windows[windows.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }

  const excerpts: string[] = [];
  let spent = 0;
  for (const [from, to] of windows) {
    if (excerpts.length > 0 && spent + (to - from) > budget) break;
    const [start, end] = snapToWords(text, from, to);
    excerpts.push(text.slice(start, end));
    spent += end - start;
  }
  return { excerpts, truncated: true };
}
