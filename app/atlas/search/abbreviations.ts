/**
 * SEARCH-55: the corpus-derived abbreviation table (acronym ↔ phrase).
 *
 * The Atlas defines its own abbreviations; nothing is curated and no LLM is used.
 * Two harvest sources, both verified:
 *
 *  1. Parenthetical definitions in document text — "Capital Ratio Requirement (CRR)".
 *     Kept only when the acronym's letters match the phrase's word initials (small
 *     connective words may be skipped), so stray parentheses harvest nothing.
 *  2. Initialisms of multi-word document names — kept only when that acronym string
 *     actually occurs somewhere in the corpus text (readers use abbreviations the
 *     corpus itself uses; ungrounded initialisms would only add noise).
 *
 * Ambiguous acronyms (two different phrases) are dropped. Acronyms shorter than 3
 * characters are never harvested (the AD/OF word-collision zone).
 *
 * Pure functions over the flattened documents; the browser loads the committed
 * artifact built by scripts/build-abbreviations.ts, the eval harvests directly.
 */
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { isStopword } from './stop-words';

export interface AbbreviationEntry {
  /** Folded acronym token as it appears in queries (e.g. "crr"). */
  acronym: string;
  /** The spelled-out phrase, folded (e.g. "capital ratio requirement"). */
  phrase: string;
  source: 'parenthetical' | 'name-initialism' | 'curated';
}

/**
 * SEARCH-82: hand-reviewed corrections applied on top of the harvest, from the
 * tracked `data/abbreviation-curation.json`. `exclude` drops a harvested
 * acronym whose string carries a more general meaning; `override` replaces a
 * harvested phrase; `add` introduces an acronym readers type although the text
 * never spells it that way (two-letter acronyms enter only here).
 *
 * SEARCH-83: an `override`/`add` value may be a LIST of phrases — an ambiguous
 * acronym carries every recorded meaning (review decision: "no need to take a
 * side"). Multi-meaning entries are offered as choices on the two-capital
 * surface and are deliberately IGNORED by the engine's silent in-query
 * expansion, which keeps requiring a single meaning so existing ranking stays
 * byte-identical.
 */
export interface AbbreviationCuration {
  exclude?: string[];
  override?: Record<string, string | string[]>;
  add?: Record<string, string | string[]>;
}

/** An acronym with every recorded meaning (SEARCH-83) — the artifact's entry shape. */
export interface AbbreviationMeanings {
  acronym: string;
  /** One or more folded phrases; a single-element list behaves exactly like SEARCH-82. */
  phrases: string[];
  source: AbbreviationEntry['source'];
}

const PARENTHETICAL = /([A-Z][A-Za-z-]*(?:\s+[A-Za-z-]+){1,5})\s*\((\p{Lu}{3,6})\)/gu;
/** Connective words an acronym may skip ("List of Registered..." → LRS or LORS). */
const SKIPPABLE = new Set(['of', 'the', 'and', 'for', 'in', 'to', 'a', 'an', 'on']);

/** True when the acronym's letters are the phrase's word initials, in order. */
export function initialsMatch(acronym: string, phrase: string): boolean {
  const letters = acronym.toLowerCase();
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  let w = 0;
  for (const letter of letters) {
    while (w < words.length && words[w][0] !== letter && SKIPPABLE.has(words[w])) w += 1;
    if (w >= words.length || words[w][0] !== letter) return false;
    w += 1;
  }
  // Every remaining word must be skippable — the phrase may not carry extra content words.
  return words.slice(w).every((word) => SKIPPABLE.has(word));
}

/** Trim a candidate phrase to the SHORTEST suffix whose initials produce the acronym. */
function trimPhrase(acronym: string, candidate: string): string | null {
  const words = candidate.split(/\s+/).filter(Boolean);
  const earliest = Math.max(0, words.length - acronym.length - 4);
  for (let start = words.length - 1; start >= earliest; start -= 1) {
    const suffix = words.slice(start).join(' ');
    if (initialsMatch(acronym, suffix)) return suffix;
  }
  return null;
}

export function harvestAbbreviations(documents: readonly FlatAtlasDocument[]): Map<string, AbbreviationEntry> {
  // null marks an acronym claimed by two different phrases: ambiguous, dropped.
  const claims = new Map<string, AbbreviationEntry | null>();
  const claim = (entry: AbbreviationEntry) => {
    const existing = claims.get(entry.acronym);
    if (existing === undefined) claims.set(entry.acronym, entry);
    else if (existing !== null && existing.phrase !== entry.phrase) {
      // Parenthetical definitions outrank name initialisms; two of the same kind clash.
      if (existing.source === 'name-initialism' && entry.source === 'parenthetical') claims.set(entry.acronym, entry);
      else if (!(existing.source === 'parenthetical' && entry.source === 'name-initialism')) {
        claims.set(entry.acronym, null);
      }
    }
  };

  const corpusText = documents.map((doc) => `${doc.name}\n${doc.content}`).join('\n');

  // Source 1: parenthetical definitions, initials-verified.
  for (const match of corpusText.matchAll(PARENTHETICAL)) {
    const [, candidate, acronym] = match;
    const phrase = trimPhrase(acronym, candidate);
    if (!phrase) continue;
    claim({ acronym: foldText(acronym), phrase: foldText(phrase), source: 'parenthetical' });
  }

  // Source 2: name initialisms, grounded in actual corpus usage of the acronym.
  const nameCandidates: Array<{ acronym: string; phrase: string }> = [];
  for (const doc of documents) {
    const words = doc.name.split(/\s+/).filter((word) => /^[A-Z]/.test(word));
    if (words.length < 2 || words.length > 5 || words.join(' ') !== doc.name) continue;
    const acronym = words
      .filter((word) => !SKIPPABLE.has(word.toLowerCase()))
      .map((word) => word[0])
      .join('');
    if (acronym.length < 3 || acronym.length > 6) continue;
    nameCandidates.push({ acronym, phrase: doc.name });
  }
  if (nameCandidates.length > 0) {
    const usagePattern = new RegExp(`\\b(${[...new Set(nameCandidates.map((c) => c.acronym))].join('|')})\\b`, 'g');
    const used = new Set([...corpusText.matchAll(usagePattern)].map((match) => match[1]));
    for (const { acronym, phrase } of nameCandidates) {
      if (!used.has(acronym)) continue;
      claim({ acronym: foldText(acronym), phrase: foldText(phrase), source: 'name-initialism' });
    }
  }

  const table = new Map<string, AbbreviationEntry>();
  for (const [acronym, entry] of claims) {
    if (!entry || isStopword(acronym)) continue;
    table.set(acronym, entry);
  }
  return table;
}

const CURATED_ACRONYM = /^[a-z0-9]{2,6}$/;

/**
 * Applies the curation strictly, so the tracked file cannot rot as the corpus
 * moves: an `exclude` or `override` naming an acronym the harvest no longer
 * produces fails the build, as does an `add` the harvest now produces itself.
 * Keys and phrases are folded like every harvested entry. Harvested entries
 * come out as single-meaning lists; curated values may carry several meanings
 * (SEARCH-83).
 */
export function applyCuration(
  table: Map<string, AbbreviationEntry>,
  curation: AbbreviationCuration,
): Map<string, AbbreviationMeanings> {
  const curated = new Map<string, AbbreviationMeanings>(
    [...table.values()].map((entry) => [
      entry.acronym,
      { acronym: entry.acronym, phrases: [entry.phrase], source: entry.source },
    ]),
  );
  const curatedEntry = (acronym: string, value: string | string[]): AbbreviationMeanings => {
    const folded = foldText(acronym.trim());
    const phrases = (Array.isArray(value) ? value : [value]).map((phrase) =>
      foldText(phrase.trim()).replace(/\s+/g, ' '),
    );
    const distinct = new Set(phrases);
    if (
      !CURATED_ACRONYM.test(folded) ||
      phrases.length === 0 ||
      distinct.size !== phrases.length ||
      phrases.some((phrase) => phrase.split(' ').length < 2)
    ) {
      throw new Error(`invalid curation entry: "${acronym}" → ${JSON.stringify(value)}`);
    }
    return { acronym: folded, phrases, source: 'curated' };
  };
  for (const raw of curation.exclude ?? []) {
    const acronym = foldText(raw.trim());
    if (!curated.delete(acronym)) throw new Error(`curation excludes "${raw}", but the harvest has no such acronym`);
  }
  for (const [raw, value] of Object.entries(curation.override ?? {})) {
    const entry = curatedEntry(raw, value);
    if (!curated.has(entry.acronym)) {
      throw new Error(`curation overrides "${raw}", but the harvest has no such acronym — move it to add`);
    }
    curated.set(entry.acronym, entry);
  }
  for (const [raw, value] of Object.entries(curation.add ?? {})) {
    const entry = curatedEntry(raw, value);
    if (curated.has(entry.acronym)) {
      throw new Error(`curation adds "${raw}", but the harvest already has it — move it to override`);
    }
    curated.set(entry.acronym, entry);
  }
  return curated;
}

/**
 * The query with one mapped acronym token replaced by its phrase, or null when no
 * token maps. Only the FIRST mapping applies (one abbreviation per query — the
 * conservative v1; multi-acronym queries stay literal).
 */
export function expandQueryTokens(
  tokens: readonly string[],
  abbreviationOf: (token: string) => AbbreviationEntry | null,
): { query: string; entry: AbbreviationEntry } | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = abbreviationOf(tokens[i]);
    if (!entry) continue;
    const mapped = [...tokens.slice(0, i), entry.phrase, ...tokens.slice(i + 1)];
    return { query: mapped.join(' '), entry };
  }
  return null;
}
