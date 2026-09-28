import MiniSearch, { type Options, type SearchResult } from 'minisearch';
import { stemmer } from 'stemmer';
import { type AbbreviationEntry, expandQueryTokens } from './abbreviations';
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { isStopword, withoutStopwords } from './stop-words';
import { type AtlasVocabularyQuery, mapAtlasVocabulary } from './vocabulary';

/** Fields fed to the inverted index, in spec §6 order (`expansion` added by SEARCH-17). */
export const SEARCH_FIELDS = ['doc_no', 'name', 'content', 'extras', 'expansion'] as const;

/** Field boosts, spec §6. */
export const FIELD_BOOSTS: Record<string, number> = {
  doc_no: 5,
  name: 3,
  content: 1,
  extras: 1,
  // Generated text (SEARCH-17): below content, so a literal match always outranks an
  // expansion-only match. The R1.2 boost sweep (2026-08-31) chose 0.25: at 0.35 and 0.5
  // expansion vocabulary lifted treasury-adjacent documents over Q11's literal answer
  // (binary gate red); 0.25 keeps all 53 criteria green with the paraphrase Recall@50
  // gain (+0.31, CI excluding zero) intact. The env override exists for future sweeps in
  // Node harnesses (bundlers resolve it to the default in the browser).
  expansion: Number(process.env.EXPANSION_BOOST ?? '') || 0.25,
};

/**
 * Fields kept on results. Deliberately minimal: `type` is read by the search filter and
 * `depth` by `boostDocument`, and nothing else is read off a result — the modal looks up
 * everything it renders via `documents[hit.id]`. Storing more duplicates the corpus inside
 * the index for no gain (measured: 7.2 MB serialized vs 3.8 MB).
 */
export const STORED_FIELDS = ['type', 'depth'] as const;

/**
 * Raised from 50 once results became relevance-ranked and the relaxed pass (below) began
 * contributing a tail: the cap is a display choice, and a longer ranked list costs only
 * scrolling, while a short one hides genuine matches.
 */
export const DEFAULT_RESULT_LIMIT = 100;

/**
 * Splits on everything that cannot appear inside a word, a document number or a
 * hyphenated compound. Unicode-aware: letters and digits of any script are word
 * characters; accents have already been folded away by `foldText`. Em and en dashes are
 * punctuation and remain separators; the non-breaking hyphen (U+2011, present in the
 * corpus) is normalised to `-` first so it behaves like one.
 */
const TOKEN_SEPARATOR = /[^\p{L}\p{N}.-]+/u;
const NON_BREAKING_HYPHEN = '‑';
const EDGE_PUNCTUATION = /^[.-]+|[.-]+$/g;

function rawTokens(text: string): string[] {
  let folded = foldText(text);
  // Rare (5 documents), so the extra pass is only paid when it is needed: this function
  // runs on every field of every document at index build.
  if (folded.includes(NON_BREAKING_HYPHEN)) folded = folded.replaceAll(NON_BREAKING_HYPHEN, '-');
  return folded
    .split(TOKEN_SEPARATOR)
    .map((token) => (hasEdgePunctuation(token) ? token.replace(EDGE_PUNCTUATION, '') : token))
    .filter(Boolean);
}

/** Cheap pre-check so the regex above runs on the rare tokens that need it, not all ~400k. */
function hasEdgePunctuation(token: string): boolean {
  const first = token.charCodeAt(0);
  const last = token.charCodeAt(token.length - 1);
  return first === 46 || first === 45 || last === 46 || last === 45; // '.' and '-'
}

/** Compounds with more parts than this are identifiers (UUIDs, hashes), not words. */
export const MAX_COMPOUND_PARTS = 3;

/**
 * The parts of a hyphenated compound and, when it is a real word, its joined form.
 *
 * `off-chain` → `off`, `chain`, `offchain`, so the 168 documents that write the hyphen and
 * the 33 that do not reach each other (SEARCH-07). Anything without a hyphen yields itself.
 *
 * Not joined: an all-digit compound (`2023-06-08` would index as `20230608`, a token nobody
 * types) and anything with more than three parts (UUIDs such as
 * `c2abdd22-fe0f-489e-b281-450e066db701` appear in document text).
 */
export function compoundPieces(token: string): string[] {
  if (!token.includes('-')) return [token];

  const parts = token.split('-').filter(Boolean);
  const joined = parts.join('');
  if (!joined || /^\d+$/.test(joined) || parts.length > MAX_COMPOUND_PARTS) return parts;
  return [...parts, joined];
}

/**
 * Index-time tokenizer.
 *
 * `doc_no` is emitted whole, so `A.1.2.3` stays one token instead of being shredded
 * into `a, 1, 2, 3` — that is what makes document-number search and its prefix
 * behaviour work.
 *
 * Function words are dropped here as well as at query time (SEARCH-05), so they neither
 * occupy the index nor skew ranking: many Atlas titles begin with "The", and the ×3 name
 * boost on `the` otherwise outranked genuine matches. A stop-word query can still match,
 * but only by prefix/fuzzy expansion onto real words (`the` → `theoretical`).
 *
 * A hyphenated compound is emitted as its parts *and* as one joined word (SEARCH-07), so
 * `offchain` reaches the documents that write `off-chain`, and vice versa.
 */
export function tokenizeField(text: string, fieldName?: string): string[] {
  if (fieldName === 'doc_no') {
    const whole = foldText(text.trim());
    return whole ? [whole] : [];
  }

  const tokens: string[] = [];
  // Index the word *and* its stem. The stem carries morphology (`compensation`,
  // `compensated` and `compensate` all reach one term); the original carries typo
  // tolerance, because a misspelling stems badly — `compensaton` stems to itself,
  // four edits from `compens`, but only one from the indexed `compensation`.
  const pushWord = (word: string) => {
    if (isStopword(word)) return;
    tokens.push(word);
    const stem = stemTerm(word);
    if (stem !== word) tokens.push(stem);
  };

  for (const token of rawTokens(text)) {
    if (token.includes('.')) {
      // Document numbers are identifiers, not words: never stem them, and never split
      // them into parts. The whole token already answers a cross-reference search —
      // `a.1.6` prefix-matches `a.1.6.4` wherever it is cited — while the parts only
      // added bare digits as searchable terms: 22,315 extra tokens for no extra hit
      // (measured: `a.1.6.4` returns 37 documents either way).
      tokens.push(token);
    } else if (!token.includes('-')) {
      // The common case, kept allocation-free: this runs ~1.3M times per index build.
      pushWord(token);
    } else {
      for (const piece of compoundPieces(token)) pushWord(piece);
    }
  }
  return tokens;
}

/**
 * Reduces a word to its stem, so `compensated`, `compensation` and `compensate` all
 * index and query as one term. Without this, "how are delegates compensated" cannot
 * reach a document that says "compensation": the two are not prefixes of each other and
 * sit three edits apart, beyond the fuzzy threshold.
 *
 * Stems are cached because the tokenizer calls this once per token *occurrence* — about
 * 1.3M times over the corpus — for only ~8,000 distinct words. Memoising cuts the index
 * build from 332 ms to 273 ms, back inside the 300 ms budget (spec §8). The cap is
 * insurance against an unbounded corpus: past it, stemming still works, it just stops
 * being cached.
 */
const STEM_CACHE_LIMIT = 50_000;
const stemCache = new Map<string, string>();

export function stemTerm(token: string): string {
  if (token.includes('.')) return token;

  const cached = stemCache.get(token);
  if (cached !== undefined) return cached;

  const stem = stemmer(token);
  if (stemCache.size < STEM_CACHE_LIMIT) stemCache.set(token, stem);
  return stem;
}

/**
 * A query's terms with completed stop words removed. The trailing token is treated as a
 * prefix in progress unless the query ends in whitespace — see `withoutStopwords`.
 *
 * A hyphenated query term becomes its **joined form only** (`off-chain` → `offchain`).
 * The index carries the joined form for every hyphenated occurrence, so this one term
 * reaches both spellings. Emitting the parts as well would be wrong under AND semantics:
 * a document that writes `offchain` has no `off` or `chain` token and would be excluded.
 */
function queryTerms(query: string): string[] {
  const terms = rawTokens(query).map(joinedCompound);
  const lastIsPrefix = terms.length > 0 && !/\s$/.test(query);
  return withoutStopwords(terms, lastIsPrefix);
}

/** The joined form of a hyphenated compound, or the token itself when there is none. */
export function joinedCompound(token: string): string {
  const pieces = compoundPieces(token);
  return pieces.length > 1 && !token.includes('.') ? pieces[pieces.length - 1] : token;
}

/**
 * True when the query has words but every one of them is a completed stop word
 * (`of the `, `what is it `). Such a query runs no search; the modal uses this to show a
 * "try a more specific term" hint instead of "No documents found".
 */
export function isStopWordOnlyQuery(query: string): boolean {
  return rawTokens(query).length > 0 && queryTerms(query).length === 0;
}

/**
 * Query-time tokenizer. Dotted terms stay whole: splitting `a.1.2` into
 * `a`, `1`, `2` under AND semantics would demand all three parts match somewhere,
 * which is not what the user meant.
 *
 * Function words are dropped and the rest stemmed, so conversational phrasing reaches
 * the same documents as the terse equivalent.
 */
export function tokenizeQuery(query: string): string[] {
  return queryTerms(query).map(stemTerm);
}

/**
 * Query tokenizer for the relaxed pass: stopwords dropped, but words left unstemmed.
 *
 * Stemming a misspelling mangles it — `delgate` stems to `delgat`, two edits from the
 * indexed `deleg`, past the fuzzy budget for so short a term. Left alone it is one edit
 * from the indexed `delegate`, so the relaxed pass recovers the typo the strict pass
 * cannot reach.
 */
export function tokenizeQueryUnstemmed(query: string): string[] {
  return queryTerms(query);
}

/**
 * Mild ranking preference for shallower documents, so Scopes and Articles edge out
 * deep supporting documents at equal text relevance (spec §7).
 */
export function depthBoost(depth: number | undefined): number {
  if (typeof depth !== 'number' || Number.isNaN(depth)) return 1;
  return 1 + Math.max(0, 4 - depth) * 0.05;
}

/**
 * SEARCH-56 measured arm: extra index fields with their boosts (e.g. the `inherited`
 * ancestor-keyword field). The shipped path passes nothing and is byte-identical.
 */
export interface IndexExtension {
  fields: string[];
  boosts: Record<string, number>;
}

/**
 * The full index configuration. Shared by `createSearchIndex` and
 * `loadSerializedSearchIndex`, because MiniSearch requires the exact same options to
 * deserialise an index as were used to build it.
 */
function indexOptions(extension?: IndexExtension): Options<FlatAtlasDocument> {
  return {
    idField: 'id',
    fields: [...SEARCH_FIELDS, ...(extension?.fields ?? [])],
    storeFields: [...STORED_FIELDS],
    tokenize: tokenizeField,
    // The tokenizers already case- and accent-fold; keep terms verbatim from here.
    processTerm: (term) => term,
    searchOptions: {
      boost: extension ? { ...FIELD_BOOSTS, ...extension.boosts } : FIELD_BOOSTS,
      // A one-character term prefix-matches most of the corpus: querying `a` touched all
      // 11,419 documents and took 49 ms against a 10 ms budget. Two characters is the
      // shortest prefix that carries any signal.
      prefix: (term) => term.length >= 2,
      // Fuzzy is for typos in words. It is skipped for document numbers (every dotted
      // number has many edit-distance-1 neighbours, and MiniSearch weights fuzzy hits
      // above prefix hits, so siblings would outrank the subtree being navigated to) and
      // for terms under four characters, where an edit budget matches half the dictionary.
      // SEARCH-73 adds the vocabulary guard on top wherever the tiered search runs —
      // this default is the fallback for direct callers only.
      fuzzy: (term) => (term.includes('.') || term.length < 4 ? false : 0.2),
      combineWith: 'AND',
      tokenize: tokenizeQuery,
      processTerm: (term) => term,
      boostDocument: (_id, _term, storedFields) => depthBoost(storedFields?.depth as number | undefined),
    },
  };
}

/** An empty index carrying the full configuration. */
export function createSearchIndex(extension?: IndexExtension): MiniSearch<FlatAtlasDocument> {
  return new MiniSearch<FlatAtlasDocument>(indexOptions(extension));
}

/**
 * Rehydrates an index serialised with `JSON.stringify(index)` (the prebuilt artifact,
 * SEARCH-17). Must stay behaviourally identical to an index built fresh from the same
 * documents — asserted by the prebuilt-index tests.
 */
export function loadSerializedSearchIndex(json: string): MiniSearch<FlatAtlasDocument> {
  return MiniSearch.loadJSON<FlatAtlasDocument>(json, indexOptions());
}

/** Synchronous build. Used by tests and scripts; the app uses the async form. */
export function buildSearchIndexSync(
  docs: FlatAtlasDocument[],
  extension?: IndexExtension,
): MiniSearch<FlatAtlasDocument> {
  const index = createSearchIndex(extension);
  index.addAll(docs);
  return index;
}

/**
 * SEARCH-09 target ids are stable for the lifetime of a built index. Cache exact
 * doc-number resolution per index so repeated keystrokes do not search for the same
 * immutable row again. `null` records a confirmed miss; the WeakMap cannot retain an
 * index after its owning tree is replaced.
 */
const vocabularyTargetIds = new WeakMap<MiniSearch<FlatAtlasDocument>, Map<string, string | number | null>>();

function vocabularyTargetId(index: MiniSearch<FlatAtlasDocument>, targetDocNo: string): string | number | undefined {
  let targets = vocabularyTargetIds.get(index);
  if (!targets) {
    targets = new Map();
    vocabularyTargetIds.set(index, targets);
  }

  const cached = targets.get(targetDocNo);
  if (cached !== undefined) return cached ?? undefined;

  const resolved =
    index.search(targetDocNo, {
      fields: ['doc_no'],
      combineWith: 'AND',
      prefix: false,
      fuzzy: false,
    })[0]?.id ?? null;
  targets.set(targetDocNo, resolved);
  return resolved ?? undefined;
}

/**
 * Chunked build that yields to the main thread between chunks (spec §5).
 *
 * 250 rather than 500: indexing each word alongside its stem made the longest chunk
 * 34 ms, and eight chunks overran a 16 ms frame. Halving the chunk halves the longest
 * pause without changing total build time, which is spent on idle callbacks anyway.
 */
export async function buildSearchIndex(docs: FlatAtlasDocument[]): Promise<MiniSearch<FlatAtlasDocument>> {
  const index = createSearchIndex();
  await index.addAllAsync(docs, { chunkSize: 250 });
  return index;
}

export interface AtlasSearchOptions {
  /** Restrict to these document types. Empty or omitted means no restriction. */
  types?: string[];
  /** Maximum hits returned. Defaults to `DEFAULT_RESULT_LIMIT`. */
  limit?: number;
  /**
   * Restrict to documents whose id passes this test — how the scope chips filter by
   * ancestry (SEARCH-08). Ancestry is deliberately not indexed (spec §3.3), so the
   * caller builds this from the documents it already holds. Applied inside every pass,
   * so the relaxed-pass trigger and the result cap both see filtered results.
   */
  includeId?: (id: number) => boolean;
  /**
   * SEARCH-34: restrict matching to these index fields (e.g. ['name'] for `title:`).
   * Omitted = all fields, the default behaviour.
   */
  fields?: string[];
  /**
   * SEARCH-09: allow a measured reader phrase to promote its one adjudicated Atlas
   * vocabulary target. Defaults to true. Explicit phrase/exact operators disable it
   * because quoted text must stay literal.
   */
  applyVocabulary?: boolean;
  /**
   * SEARCH-55: corpus-derived abbreviation lookup (acronym → phrase). When the
   * literal strict pass is thin and a content token maps, the phrase-mapped query
   * runs as a companion route whose hits append BELOW every literal result — the
   * literal ranking is never displaced. Omitted = no expansion.
   */
  abbreviationOf?: (token: string) => AbbreviationEntry | null;
}

export interface AtlasSearchHit {
  id: number;
  score: number;
  /** Terms that actually matched — used for highlighting. */
  terms: string[];
  /** Field names the terms matched in, e.g. ['name', 'content'] — used to decide what to preview. */
  fields: string[];
  /**
   * Where the row came from (SEARCH-30): the strict AND pass, a relaxed keyword pass
   * (stemmed / typo recovery), the semantic rung, or the SEARCH-55 abbreviation
   * companion route. Set on the hybrid path and on expanded rows; absent otherwise.
   */
  provenance?: 'strict' | 'relaxed' | 'rung' | 'expanded';
  /**
   * SEARCH-30: a semantic-rung hit whose dense score is below HYBRID_RUNG_WEAK_SCORE —
   * a guess, not a match. Kept in the ranking but hidden by default in the UI behind
   * the "show weak matches" control, and excluded from the measured default view.
   */
  weak?: boolean;
  /** This is the one keyword hit promoted through SEARCH-09's companion lookup. */
  vocabulary?: boolean;
}

export interface AtlasSearchResults {
  hits: AtlasSearchHit[];
  /** Matches before the limit was applied, for the count line. */
  total: number;
  /**
   * SEARCH-30: not a single query word matched anything (strict and relaxed both
   * empty) — every hit is a semantic guess. Drives the "No exact matches for …"
   * notice. Set on the hybrid path only.
   */
  noKeywordMatches?: boolean;
  /** The transparent companion lookup applied by SEARCH-09, when visible. */
  vocabulary?: AtlasVocabularyQuery;
  /** SEARCH-55: the abbreviation expansion applied, when expanded rows are visible. */
  abbreviation?: { acronym: string; phrase: string };
}

/** Flattens MiniSearch match metadata (term → fields) into a distinct field list. */
function matchedFields(match: Record<string, string[]>): string[] {
  return Array.from(new Set(Object.values(match).flat()));
}

/**
 * Runs a query in two passes.
 *
 * The strict pass requires every term (AND) and supplies the precision the terse
 * queries in the eval set depend on. When it returns fewer results than the caller
 * asked for, a relaxed pass (OR) is appended *below* it, never interleaved — so strict
 * matches always outrank relaxed ones and precision at the top is unchanged.
 *
 * This is what lets a conversational query survive a word the target document does not
 * contain: "what happens during liquidation" finds nothing under AND because `happens`
 * appears in only 5 documents, but the liquidation documents still surface in the
 * relaxed tail, ranked by how many query terms they match.
 *
 * Type filtering happens inside the engine, so the cap is applied *after* filtering,
 * not before it (spec §9).
 *
 * SEARCH-09 adds one tightly bounded exception: for its measured reader phrases, one
 * named target may be promoted to the acceptance boundary. All other results retain
 * the literal query's relative order.
 */
// SEARCH-73: repair only real typos. A query term gets fuzzy repair ONLY when
// the term itself is absent from the index vocabulary — "compensaton" is
// unknown and repairs to "compensation", but "slope" is a known corpus word,
// so it never matches "scope" (one edit away, and a real word — the
// slippery-slope case found in review). Known-ness is probed through the index
// itself so the guard works identically on a freshly built and a rehydrated
// prebuilt index; probes are cached per index instance.
const knownTermCache = new WeakMap<MiniSearch<FlatAtlasDocument>, Map<string, boolean>>();
function termIsIndexed(index: MiniSearch<FlatAtlasDocument>, term: string): boolean {
  let cache = knownTermCache.get(index);
  if (!cache) {
    cache = new Map();
    knownTermCache.set(index, cache);
  }
  let known = cache.get(term);
  if (known === undefined) {
    known =
      index.search(term, {
        tokenize: (text) => [text],
        processTerm: (candidate) => candidate,
        prefix: false,
        fuzzy: false,
        combineWith: 'AND',
      }).length > 0;
    cache.set(term, known);
  }
  return known;
}

/** The SEARCH-73 fuzzy rule for one index: the default gates plus the vocabulary guard. */
export function fuzzyWithVocabularyGuard(index: MiniSearch<FlatAtlasDocument>): (term: string) => number | false {
  return (term) => (term.includes('.') || term.length < 4 || termIsIndexed(index, term) ? false : 0.2);
}

export function searchAtlas(
  index: MiniSearch<FlatAtlasDocument>,
  query: string,
  options: AtlasSearchOptions = {},
): AtlasSearchResults {
  const { strict, relaxed, total, vocabulary, expanded, abbreviation } = searchAtlasTiered(index, query, options);
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const hits = [...strict, ...relaxed, ...(expanded ?? [])].slice(0, limit);
  return {
    total,
    hits,
    ...(vocabulary && hits.some((hit) => hit.vocabulary) ? { vocabulary } : {}),
    ...(abbreviation && hits.some((hit) => hit.provenance === 'expanded') ? { abbreviation } : {}),
  };
}

export interface AtlasSearchTiers {
  /** Hits from the strict AND pass, score-then-tree ordered. */
  strict: AtlasSearchHit[];
  /** Hits appended by the relaxed OR passes (stemmed, then unstemmed), deduplicated. */
  relaxed: AtlasSearchHit[];
  /** Matches before the limit was applied, for the count line. */
  total: number;
  /** Strict count before SEARCH-09 promotion; the dense gate must remain literal. */
  literalStrictCount?: number;
  /** The transparent companion lookup applied by SEARCH-09, when any. */
  vocabulary?: AtlasVocabularyQuery;
  /**
   * SEARCH-55: hits from the abbreviation companion route (phrase-mapped query),
   * deduplicated against both literal tiers, capped, provenance 'expanded'. They
   * append BELOW every literal result wherever tiers are consumed.
   */
  expanded?: AtlasSearchHit[];
  /** The expansion that produced `expanded`, for the notice. */
  abbreviation?: { acronym: string; phrase: string };
}

/**
 * The two passes of `searchAtlas`, kept separate. The strict/relaxed boundary is the
 * engine's own confidence signal: hybrid fusion (SEARCH-21) places dense results as a
 * rung between the passes, so callers need to know where one ends and the other begins.
 * `searchAtlas` is the concatenation and shares all behaviour.
 *
 * Each tier is capped at `limit` hits; the relaxed passes run only when the strict pass
 * returned fewer than `limit` results, exactly as before.
 */
export function searchAtlasTiered(
  index: MiniSearch<FlatAtlasDocument>,
  query: string,
  options: AtlasSearchOptions = {},
): AtlasSearchTiers {
  const vocabulary = options.applyVocabulary === false ? null : mapAtlasVocabulary(query);
  if (tokenizeQuery(query).length === 0) return { strict: [], relaxed: [], total: 0 };

  const types = options.types?.length ? new Set(options.types) : null;
  const filter = types ? (result: SearchResult) => types.has(result.type as string) : undefined;
  const included = (result: SearchResult) => (options.includeId ? options.includeId(Number(result.id)) : true);
  // MiniSearch orders by score only; break ties by tree order so a prefix query like
  // `A.1` lists A.1.1, A.1.2, … rather than an arbitrary permutation.
  const byScoreThenTree = (a: SearchResult, b: SearchResult) => b.score - a.score || Number(a.id) - Number(b.id);
  const toHit = (result: SearchResult, vocabularyMatch = false): AtlasSearchHit => ({
    id: Number(result.id),
    score: result.score,
    terms: result.terms,
    fields: matchedFields(result.match),
    ...(vocabularyMatch ? { vocabulary: true } : {}),
  });

  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  // SEARCH-73: the vocabulary guard applies to every literal pass, strict and
  // relaxed alike — a known word is never treated as a typo of another.
  const fuzzy = fuzzyWithVocabularyGuard(index);
  const runLiteralPasses = (searchQuery: string): { strict: SearchResult[]; append: SearchResult[] } => {
    const strict = index
      .search(searchQuery, { filter, combineWith: 'AND', fields: options.fields, fuzzy })
      .filter(included)
      .sort(byScoreThenTree);

    const append: SearchResult[] = [];
    if (strict.length < limit) {
      // Two relaxed passes, appended in order. The stemmed one recovers documents that use
      // a different form of a query word; the unstemmed one recovers typos, which stem
      // badly. Both sit below every strict match, so precision at the top is unaffected.
      const seen = new Set(strict.map((result) => result.id));
      for (const tokenize of [tokenizeQuery, tokenizeQueryUnstemmed]) {
        const pass = index
          .search(searchQuery, { filter, combineWith: 'OR', tokenize, fields: options.fields, fuzzy })
          .filter((result) => !seen.has(result.id) && included(result))
          .sort(byScoreThenTree);
        for (const result of pass) {
          seen.add(result.id);
          append.push(result);
        }
      }
    }

    return { strict, append };
  };

  const { strict, append } = runLiteralPasses(query);
  const literalStrictCount = strict.length;
  let promotedId: string | number | undefined;

  if (vocabulary && limit > 0) {
    // Resolve the one adjudicated target through the index itself. Exact doc-number
    // matching avoids coupling result ids to one flattened corpus order; the mapped
    // search below still has to retrieve that id under all active filters and fields.
    const targetId = vocabularyTargetId(index, vocabulary.targetDocNo);

    if (targetId !== undefined) {
      const strictTargetIndex = strict.findIndex((result) => result.id === targetId);
      const relaxedTargetIndex = strictTargetIndex < 0 ? append.findIndex((result) => result.id === targetId) : -1;
      const literalRank =
        strictTargetIndex >= 0
          ? strictTargetIndex + 1
          : relaxedTargetIndex >= 0
            ? strict.length + relaxedTargetIndex + 1
            : 0;

      // Preserve every literal result above the acceptance boundary, and preserve the
      // relative order of every non-target result. SEARCH-09 may move only its named
      // target, and only when that target is currently below the measured bar.
      if (literalRank === 0 || literalRank > vocabulary.promotionRank) {
        const mapped = runLiteralPasses(vocabulary.retrievalQuery);
        const mappedTarget =
          mapped.strict.find((result) => result.id === targetId) ??
          mapped.append.find((result) => result.id === targetId);

        if (mappedTarget) {
          if (strictTargetIndex >= 0) strict.splice(strictTargetIndex, 1);
          if (relaxedTargetIndex >= 0) append.splice(relaxedTargetIndex, 1);
          const insertion = Math.min(vocabulary.promotionRank - 1, strict.length);
          strict.splice(insertion, 0, mappedTarget);
          promotedId = targetId;
        }
      }
    }
  }

  // SEARCH-55: the abbreviation companion route — a recovery mechanism, so it runs
  // only when the literal strict pass is thin (the same signal that gates the dense
  // rung; the constant is mirrored here to avoid a circular import). Mapped hits
  // append below every literal result and never displace the literal ranking.
  const ABBREVIATION_STRICT_GATE = 10;
  const ABBREVIATION_EXPANDED_CAP = 20;
  let expanded: AtlasSearchHit[] = [];
  let abbreviation: { acronym: string; phrase: string } | undefined;
  if (options.abbreviationOf && literalStrictCount < ABBREVIATION_STRICT_GATE && limit > 0) {
    const mapping = expandQueryTokens(tokenizeQueryUnstemmed(query), options.abbreviationOf);
    if (mapping) {
      const mapped = runLiteralPasses(mapping.query);
      const seen = new Set([...strict, ...append].map((result) => result.id));
      const extra = [...mapped.strict, ...mapped.append]
        .filter((result) => !seen.has(result.id))
        .slice(0, ABBREVIATION_EXPANDED_CAP);
      if (extra.length > 0) {
        expanded = extra.map((result) => ({ ...toHit(result), provenance: 'expanded' as const }));
        abbreviation = { acronym: mapping.entry.acronym, phrase: mapping.entry.phrase };
      }
    }
  }

  return {
    total: strict.length + append.length + expanded.length,
    strict: strict.slice(0, limit).map((result) => toHit(result, result.id === promotedId)),
    relaxed: append.slice(0, limit).map((result) => toHit(result)),
    literalStrictCount,
    ...(promotedId !== undefined && vocabulary ? { vocabulary } : {}),
    ...(expanded.length > 0 && abbreviation ? { expanded, abbreviation } : {}),
  };
}
