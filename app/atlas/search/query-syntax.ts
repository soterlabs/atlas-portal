/**
 * Query syntax (SEARCH-34/35): the operator subset of the legacy sky-atlas.io
 * cheatsheet, parsed out of the search box and fed into existing filter machinery —
 * the same `types` / `includeId` / field options the UI chips use.
 *
 *   type:Annotation        type:"Scenario Variation"      type:Scenario_Variation
 *   in:A.1.2               title:facilitator              a491d7d0[-…]  (uuid jump)
 *   "properly implemented" (whole-word phrase, case-insensitive)
 *   'delegatedSigners'     (whole-word phrase, case-SENSITIVE)
 *   -slippery              (exclude documents containing the word)
 *
 * Safety rules, deliberately conservative: only a complete `key:value` token parses;
 * unknown keys, bare keys and unclosed quotes stay literal search terms — a malformed
 * operator is never an error, it is just text. Phrase/exact words are kept in the
 * retrieval terms (so candidates are found by the engine) and then narrowed by a
 * document-text predicate; excluded words are removed from the terms. Deliberately
 * NOT implemented: `~N` fuzzy (typo recovery is automatic and measured), 0x-address
 * and chainlog-id special cases (the tokenizer already handles them).
 */

export interface ParsedQuery {
  /** Residual free text plus phrase words — what the engine retrieves candidates by. */
  terms: string;
  /** `type:` filters, normalised (underscores become spaces). */
  types: string[];
  /** `in:` subtree roots, as typed (doc numbers). */
  scopes: string[];
  /** `title:` was used — restrict matching to the document name field. */
  titleOnly: boolean;
  /** `"…"` whole-word phrases, matched case-insensitively against document text. */
  phrases: string[];
  /** `'…'` whole-word phrases, matched case-SENSITIVELY against document text. */
  exactPhrases: string[];
  /** `-word` exclusions: documents containing the word are dropped. */
  excludes: string[];
  /**
   * The whole query is a UUID or a UUID prefix (≥ 8 hex digits, dashes optional):
   * a navigation jump, not a search — UUIDs are not indexed text.
   */
  uuidJump?: string;
  /**
   * Every parsed operator with the exact text it consumed — the UI renders these as
   * removable pills, and removal is `query.replace(raw, '')`.
   */
  operators: Array<{ key: 'type' | 'in' | 'title' | 'phrase' | 'exact' | 'not'; value: string; raw: string }>;
}

/** Complete `key:value` tokens: quoted values need their closing quote to parse. */
const OPERATOR_PATTERN = /(^|\s)(type|in|title):("([^"]+)"|([^\s"]+))/gi;
/** Complete quoted phrases; an unclosed quote stays literal. */
const PHRASE_PATTERN = /"([^"]+)"/g;
/**
 * Complete single-quoted phrases. The opening quote must sit at a word boundary (start
 * of the query or after whitespace) and the closing one must end the word — whitespace,
 * end of query, or trailing punctuation (`'phrase'?`) — so an apostrophe inside a word
 * ("what's", "facilitator's") never opens a phrase.
 */
const EXACT_PATTERN = /(^|\s)'([^']+)'(?=$|\s|[.,;:!?)\]])/g;
/** `-word` exclusion: a complete word after the dash, never a lone dash. */
const EXCLUDE_PATTERN = /(^|\s)-([^\s"'-][^\s"']*)/g;
/** ≥ 8 hex digits, dashes allowed anywhere, nothing else — a UUID or its prefix. */
const UUID_PATTERN = /^[0-9a-f][0-9a-f-]*$/i;

export function parseQuerySyntax(raw: string): ParsedQuery {
  const trimmed = raw.trim();

  const bare = trimmed.replace(/-/g, '');
  // ≥ 8 hex digits with at least one letter: an all-digit run is a number, not an id
  // (the rule identifier-query.ts applies to identifier tokens).
  if (UUID_PATTERN.test(trimmed) && /^[0-9a-f]{8,32}$/i.test(bare) && /[a-f]/i.test(bare)) {
    return {
      terms: '',
      types: [],
      scopes: [],
      titleOnly: false,
      phrases: [],
      exactPhrases: [],
      excludes: [],
      uuidJump: bare.toLowerCase(),
      operators: [],
    };
  }

  const types: string[] = [];
  const scopes: string[] = [];
  let titleOnly = false;
  const titleTerms: string[] = [];
  const phrases: string[] = [];
  const exactPhrases: string[] = [];
  const excludes: string[] = [];
  const operators: ParsedQuery['operators'] = [];

  let residual = trimmed.replace(
    OPERATOR_PATTERN,
    (match, leading: string, key: string, _value: string, quoted?: string, plain?: string) => {
      const value = (quoted ?? plain ?? '').trim();
      if (!value) return match; // bare `type:` stays literal
      const raw = match.slice(leading.length);
      switch (key.toLowerCase()) {
        case 'type': {
          const normalized = value.replace(/_/g, ' ');
          types.push(normalized);
          operators.push({ key: 'type', value: normalized, raw });
          break;
        }
        case 'in':
          scopes.push(value);
          operators.push({ key: 'in', value, raw });
          break;
        case 'title':
          titleOnly = true;
          titleTerms.push(value);
          operators.push({ key: 'title', value, raw });
          break;
      }
      return leading; // consume the operator, keep the word boundary
    },
  );

  residual = residual.replace(PHRASE_PATTERN, (raw, phrase: string) => {
    const value = phrase.trim();
    if (!value) return raw;
    phrases.push(value);
    operators.push({ key: 'phrase', value, raw });
    return ' ';
  });

  residual = residual.replace(EXACT_PATTERN, (match, leading: string, phrase: string) => {
    const value = phrase.trim();
    if (!value) return match;
    exactPhrases.push(value);
    operators.push({ key: 'exact', value, raw: match.slice(leading.length) });
    return leading; // consume the phrase, keep the word boundary
  });

  residual = residual.replace(EXCLUDE_PATTERN, (match, leading: string, word: string) => {
    excludes.push(word);
    operators.push({ key: 'not', value: word, raw: match.slice(leading.length) });
    return leading;
  });

  // Phrase words stay retrievable terms; the phrase predicate then narrows candidates.
  const terms = [residual, ...titleTerms, ...phrases, ...exactPhrases].join(' ').replace(/\s+/g, ' ').trim();
  return { terms, types, scopes, titleOnly, phrases, exactPhrases, excludes, operators };
}
