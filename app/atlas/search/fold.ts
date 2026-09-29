/**
 * Case- and accent-folding shared by the tokenizers, the highlighter and the
 * extra-field matcher, so index-time, query-time and render-time comparisons
 * can never drift apart.
 *
 * `Société` → `societe`, `Größe` → `große` (ß has no decomposition; it is kept).
 */

const COMBINING_MARKS = /\p{M}+/gu;

/** Folds a string: NFD-decompose, drop combining marks, lowercase. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

export interface FoldedText {
  /** The folded string. */
  folded: string;
  /**
   * `map[i]` is the index in the original string of the character that produced
   * `folded[i]`. Lets a match found in `folded` be sliced out of the original.
   */
  map: number[];
}

/**
 * Folds a string while recording where each folded character came from.
 *
 * Folding is done per original character so the offset map stays exact even when
 * one character folds to several (`İ` → `i̇` → `i`) or to none (a lone combining mark).
 */
export function foldTextWithMap(text: string): FoldedText {
  let folded = '';
  const map: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    // Fold code points, not UTF-16 units, so surrogate pairs stay intact.
    const codePoint = text.codePointAt(index) as number;
    const char = String.fromCodePoint(codePoint);
    const foldedChar = foldText(char);

    for (let offset = 0; offset < foldedChar.length; offset += 1) map.push(index);
    folded += foldedChar;

    if (codePoint > 0xffff) index += 1;
  }

  return { folded, map };
}

/**
 * Converts a `[start, end)` range in the folded string back to a range in the
 * original. The end is extended over any combining marks that followed the last
 * matched character, so a highlight never splits a grapheme like `e` + `́`.
 */
export function unfoldRange(text: string, { map }: FoldedText, start: number, end: number): [number, number] {
  if (end <= start) return [0, 0];

  const originalStart = map[start];
  let originalEnd = map[end - 1] + 1;
  while (originalEnd < text.length && /\p{M}/u.test(text[originalEnd])) originalEnd += 1;

  return [originalStart, originalEnd];
}
