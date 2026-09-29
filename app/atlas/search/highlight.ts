import { joinedRunStem } from './exactness';
import { type FoldedText, foldText, foldTextWithMap, unfoldRange } from './fold';
import { MAX_COMPOUND_PARTS, joinedCompound, stemTerm } from './search-index';

/** Default snippet width, spec §9. */
export const SNIPPET_LENGTH = 150;

export interface HighlightSegment {
  text: string;
  /** True when this segment is a query-term match and should be marked. */
  match: boolean;
}

/** Distinct, folded, non-empty terms, longest first. */
function usableTerms(terms: string[]): string[] {
  return (
    Array.from(new Set(terms.map((term) => foldText(term.trim())).filter(Boolean)))
      // Longest first, so an overlapping shorter term cannot claim part of a longer match.
      .sort((a, b) => b.length - a.length)
  );
}

/**
 * Words and document numbers, without the trailing period of a sentence.
 * `liquidation.` yields `liquidation`; `A.1.6.4` stays whole.
 */
const WORD_PATTERN = /[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*/gu;

/**
 * The terms the engine reports are *stems* (`compens`), which appear nowhere in the text
 * verbatim. Matching them as substrings would mark half a word — `compens`ation. So the
 * highlighter compares whole words by stem instead, and accepts the literal term too so
 * callers passing plain words still work.
 */
interface Wanted {
  /** Folded terms, their stems, and the joined form of hyphenated terms. */
  stems: Set<string>;
  /** Dotted terms (document numbers), matched by prefix. */
  dotted: string[];
}

function buildWanted(terms: string[]): Wanted {
  const stems = new Set<string>();
  const dotted: string[] = [];
  for (const term of usableTerms(terms)) {
    stems.add(term);
    stems.add(stemTerm(term));
    if (term.includes('.')) {
      dotted.push(term);
    } else if (term.includes('-')) {
      // A raw hyphenated term marks what the query pipeline searches for:
      // its joined form ("off-chain" → "offchain").
      const joined = joinedCompound(term);
      stems.add(joined);
      stems.add(stemTerm(joined));
    }
  }
  return { stems, dotted };
}

/**
 * Folded-text ranges to mark, in ascending order. The scan is longest-first:
 * each word is first read joined with its neighbours (up to MAX_COMPOUND_PARTS
 * words, the same reading the exact test uses, SEARCH-70/77), so "off-chain" —
 * and "off chain", and "collateral-onboarding-checklist" — is marked as one whole
 * span, separators included, when the term is the joined form. A word matched
 * alone is marked by literal, stem, or doc-number prefix as before.
 */
function* matchRanges(folded: string, wanted: Wanted): Generator<[number, number]> {
  const words = [...folded.matchAll(WORD_PATTERN)].map((match) => ({ text: match[0], start: match.index ?? 0 }));
  const alone = (word: string): boolean => {
    if (wanted.stems.has(word) || wanted.stems.has(stemTerm(word))) return true;
    // A document-number query is a prefix search: `A.1.6` should mark `A.1.6.4` too.
    return wanted.dotted.some((term) => word.startsWith(`${term}.`));
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    let consumed = false;
    for (let length = MAX_COMPOUND_PARTS; length >= 2; length--) {
      const run = words.slice(index, index + length);
      if (run.length < length) continue;
      if (wanted.stems.has(joinedRunStem(run.map((entry) => entry.text)))) {
        const last = run[run.length - 1];
        yield [word.start, last.start + last.text.length];
        index += length - 1; // every word of the run belongs to the mark
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    if (alone(word.text)) yield [word.start, word.start + word.text.length];
  }
}

/**
 * Splits text into alternating matched and unmatched segments. Every term is
 * highlighted, not just a contiguous phrase (spec §9). Matching is case- and
 * accent-insensitive (`societe` marks `Société`), but the segments are sliced from the
 * original text, so rejoining them always reproduces the input exactly.
 */
export function splitHighlight(text: string, terms: string[]): HighlightSegment[] {
  const wanted = buildWanted(terms);
  if (wanted.stems.size === 0) return [{ text, match: false }];

  const folded = foldTextWithMap(text);
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (const [foldedStart, foldedEnd] of matchRanges(folded.folded, wanted)) {
    const [start, end] = unfoldRange(text, folded, foldedStart, foldedEnd);
    // Folding can only shrink, never reorder, so matches stay in ascending order —
    // but a match that unfolds to nothing (or overlaps the previous one) is skipped.
    if (end <= start || start < cursor) continue;

    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/** Original-text offset of the earliest occurrence of any term, or -1. */
function firstMatchOffset(text: string, folded: FoldedText, terms: string[]): number {
  for (const [start] of matchRanges(folded.folded, buildWanted(terms))) {
    return unfoldRange(text, folded, start, start + 1)[0];
  }
  return -1;
}

/**
 * Extracts a window of text centred on the earliest matching term, with ellipses
 * marking where text was cut. Falls back to the head of the text when no term occurs.
 */
export function buildSnippet(text: string, terms: string[], maxLength: number = SNIPPET_LENGTH): string {
  if (text.length <= maxLength) return text;

  const firstMatch = firstMatchOffset(text, foldTextWithMap(text), terms);
  if (firstMatch === -1) return `${text.slice(0, maxLength).trim()}…`;

  let start = Math.max(0, firstMatch - Math.floor(maxLength / 2));
  const end = Math.min(text.length, start + maxLength);
  start = Math.max(0, end - maxLength);

  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}
