/**
 * Hybrid search (SEARCH-21 part 2): the adopted offline configuration `hyb10r-L2-c`
 * wired into the engine on SEARCH-19's serving pieces.
 *
 * The design, exactly as measured (SEARCH-21):
 *
 *   1. strict AND pass on top. SEARCH-09 may promote its one named target to a bounded
 *      position; every other keyword result retains literal order;
 *   2. only when the strict pass has fewer than `HYBRID_STRICT_GATE` hits — the
 *      engine's own "keyword search cannot answer this" signal — a rung of
 *      `HYBRID_RUNG_SIZE` dense results not already in strict, embedded from the
 *      canonicalised query (sorted unstemmed tokens, so reversed word orders embed
 *      identically and spec §7 word-order independence holds by construction). Since
 *      SEARCH-44 (adopted 2026-09-04) the local rung is filled cluster-first: one
 *      representative per duplicate family down the full exact ranking, admissibility
 *      checked during selection — no fetch window, so filters cannot starve it;
 *   3. the relaxed OR passes below, unchanged.
 *
 * The composed output is a full **candidate list** (up to the tiered depth), passed
 * through a pluggable **selection stage** before the display cut. The stage is the
 * SEARCH-22 seam: collapse, MMR-as-greedy-selection and the per-entity cap plug in
 * there and always select *from the pool* — they never merely reorder an already
 * truncated top 10. In this ticket the stage is the identity.
 *
 * Failure contract: `searchAtlasHybrid` never throws and never breaks search — any
 * embedder or store failure, a missing backend, or a gate that says "keyword is
 * confident" all return null, which means "the keyword results stand".
 */
import type MiniSearch from 'minisearch';
import type { FlatAtlasDocument } from './flatten-documents';
import { isIdentifierQuery } from './identifier-query';
import type { QueryEmbedder } from './query-embedder';
import {
  type AtlasSearchHit,
  type AtlasSearchOptions,
  type AtlasSearchResults,
  type AtlasSearchTiers,
  DEFAULT_RESULT_LIMIT,
  searchAtlasTiered,
  tokenizeQueryUnstemmed,
} from './search-index';
import type { DenseHit, VectorStore } from './vector-store';

/** Rung only when the strict pass has fewer hits than this (measured: K ∈ {5,10,20} tie; 10 = primary-gate budget). */
export const HYBRID_STRICT_GATE = 10;
/**
 * SEARCH-30: rung hits below this dense cosine are marked weak — guesses, hidden by
 * default in the UI (revealable), excluded from the measured default view. Picked from
 * the measured emission distributions (recorded offline):
 * the largest line hiding zero judged-relevant and zero unjudged emissions on the dev
 * set (min relevant 0.625) while hiding 82 of 90 out-of-vocabulary probe emissions
 * (probe median 0.552). The distributions overlap near the boundary, so a perfect line
 * does not exist — the 8 leaking guesses are covered by the "similar" labeling and the
 * no-exact-match notice instead. Retune only with a measured re-evaluation.
 */
export const HYBRID_RUNG_WEAK_SCORE = 0.6;
/** Dense results inserted between strict and relaxed. */
export const HYBRID_RUNG_SIZE = 10;
/** Depth of the candidate list handed to the selection stage. */
export const HYBRID_CANDIDATE_DEPTH = 200;

/**
 * The SEARCH-22 seam: selects the display list *from* the full candidate list.
 * Implementations may reorder, drop, or group, but must only use candidates given.
 */
export type SelectionStage = (candidates: AtlasSearchHit[]) => AtlasSearchHit[];

export const identitySelection: SelectionStage = (candidates) => candidates;

/** The dense side of the hybrid: the loaded vector store and a query embedder. */
export interface DenseBackend {
  store: VectorStore;
  embedder: QueryEmbedder;
}

/**
 * Dense retrieval performed by the application server (SEARCH-20). The browser sends
 * only the canonical query and receives a small ranked hit list; model weights and the
 * document-vector blob never enter the browser process.
 */
export interface RemoteDenseBackend {
  kind: 'remote';
  /** Number of rows in the server's vector artifact, used as a cheap stale-corpus guard. */
  count: number;
  search(query: string, limit: number): Promise<DenseHit[]>;
}

export type HybridDenseBackend = DenseBackend | RemoteDenseBackend;

function isRemoteBackend(backend: HybridDenseBackend): backend is RemoteDenseBackend {
  return 'kind' in backend && backend.kind === 'remote';
}

function reportDenseState(
  callback: ((state: 'loading' | 'available' | 'unavailable') => void) | undefined,
  state: 'loading' | 'available' | 'unavailable',
): void {
  try {
    callback?.(state);
  } catch {
    // UI telemetry must never alter retrieval or violate the never-throw contract.
  }
}

/**
 * The canonical dense-query text: sorted unstemmed content tokens. Both word orders of
 * a query produce the same string, hence the same embedding, hence the same rung.
 * Empty when the query has no content tokens (nothing to embed).
 */
export function canonicalDenseQuery(query: string): string {
  return tokenizeQueryUnstemmed(query).sort().join(' ');
}

/**
 * Pure composition of the hybrid candidate list — the exact `hyb10r-L2-c` ladder the
 * offline harness measured, factored out so tests and the evaluation runner exercise
 * the same code the browser runs. `denseHits` must already be filtered to admissible
 * documents (type and scope filters); rows are flatten-order ids (guaranteed by the
 * vector manifest's corpus-hash check).
 */
export function composeHybrid(
  tiers: AtlasSearchTiers,
  denseHits: DenseHit[],
  options: {
    limit: number;
    select?: SelectionStage;
    /**
     * The census family of a document (SEARCH-22 part B; standard since SEARCH-44):
     * the rung keeps only the first dense result per family. The browser always
     * passes the census `familyOf`; absent, every document is its own family.
     */
    rungFamilyOf?: (docNo: string) => string;
  },
): AtlasSearchResults {
  const select = options.select ?? identitySelection;
  const literalStrictCount = tiers.literalStrictCount ?? tiers.strict.length;

  const strictIds = new Set(tiers.strict.map((hit) => hit.id));
  // SEARCH-55: documents the abbreviation route recovered. A WEAK rung guess about
  // the same document yields to the expanded row (a phrase match beats a sub-line
  // similarity guess); a strong rung row keeps precedence and the expanded copy
  // deduplicates away below.
  const expandedIds = new Set((tiers.expanded ?? []).map((hit) => hit.id));
  // The same yield rule for the relaxed tier (bug 10): a below-threshold guess about a
  // document the keyword engine actually found (full-coverage typo repairs included)
  // must not swallow that match behind "show weak matches".
  const relaxedIds = new Set(tiers.relaxed.map((hit) => hit.id));
  let rung: AtlasSearchHit[] = [];
  if (literalStrictCount < HYBRID_STRICT_GATE) {
    const rungFamilies = new Set<string>();
    rung = denseHits
      .filter((hit) => {
        if (strictIds.has(hit.row)) return false;
        if (hit.score < HYBRID_RUNG_WEAK_SCORE && (expandedIds.has(hit.row) || relaxedIds.has(hit.row))) return false;
        if (!options.rungFamilyOf) return true;
        const family = options.rungFamilyOf(hit.docNo);
        if (rungFamilies.has(family)) return false;
        rungFamilies.add(family);
        return true;
      })
      .slice(0, HYBRID_RUNG_SIZE)
      .map((hit) => ({
        id: hit.row,
        score: hit.score,
        terms: [],
        fields: [],
        provenance: 'rung' as const,
        // A guess, not a match (SEARCH-30): below the measured weak line.
        ...(hit.score < HYBRID_RUNG_WEAK_SCORE ? { weak: true } : {}),
      }));
  }

  const emitted = new Set([...strictIds, ...rung.map((hit) => hit.id)]);
  const relaxedRows = tiers.relaxed
    .filter((hit) => !emitted.has(hit.id))
    .map((hit) => ({ ...hit, provenance: 'relaxed' as const }));
  for (const hit of relaxedRows) emitted.add(hit.id);
  // SEARCH-55: abbreviation-expanded rows append below every literal and rung row.
  const expandedRows = (tiers.expanded ?? []).filter((hit) => !emitted.has(hit.id));
  const candidates = [
    ...tiers.strict.map((hit) => ({ ...hit, provenance: 'strict' as const })),
    ...rung,
    ...relaxedRows,
    ...expandedRows,
  ];
  const selected = select(candidates);
  const hits = selected.slice(0, options.limit);
  return {
    total: candidates.length,
    hits,
    ...(tiers.strict.length === 0 && tiers.relaxed.length === 0 ? { noKeywordMatches: true } : {}),
    ...(tiers.vocabulary && hits.some((hit) => hit.vocabulary) ? { vocabulary: tiers.vocabulary } : {}),
    ...(tiers.abbreviation && hits.some((hit) => hit.provenance === 'expanded')
      ? { abbreviation: tiers.abbreviation }
      : {}),
  };
}

/**
 * The async hybrid path. Returns the upgraded results, or **null** whenever the
 * keyword results should stand: strict pass ≥ gate (keyword is confident — the dense
 * backend is not even loaded), no content tokens, no backend available, or any dense
 * failure. The `dense` argument is a lazy provider so that a query the gate answers
 * never pays for the store or the model (§9b).
 */
export async function searchAtlasHybrid(
  index: MiniSearch<FlatAtlasDocument>,
  documents: FlatAtlasDocument[],
  query: string,
  dense: () => Promise<HybridDenseBackend | null>,
  options: AtlasSearchOptions & {
    select?: SelectionStage;
    /**
     * SEARCH-29 opt-in: also run `select` when the strict gate suppresses the rung
     * (synchronous, dense-free). Off (the SEARCH-22 shipped default), a confident
     * keyword pass returns null and the keyword results stand unstaged.
     */
    applySelectWithoutRung?: boolean;
    rungFamilyOf?: (docNo: string) => string;
    /** UI telemetry only; ranking and failure semantics do not depend on it. */
    onDenseState?: (state: 'loading' | 'available' | 'unavailable') => void;
  } = {},
): Promise<AtlasSearchResults | null> {
  try {
    const tiers = searchAtlasTiered(index, query, { ...options, limit: HYBRID_CANDIDATE_DEPTH });
    const literalStrictCount = tiers.literalStrictCount ?? tiers.strict.length;
    if (literalStrictCount >= HYBRID_STRICT_GATE) {
      // The keyword pass is confident: the dense backend is never loaded (§9b). A
      // selection stage that opts in still applies — strict-heavy queries are exactly
      // where repetition crowds the first screen (the `maximum cap` exhibit has 659
      // strict hits). Opt-in (SEARCH-29), because the same reordering against the
      // 100-cut is exactly what a stage not designed for it gets wrong: applying the
      // shipped SEARCH-22 collapse here pushed two gate secondaries below the cut.
      // Composing with an empty rung is synchronous and dense-free.
      if (!options.select || !options.applySelectWithoutRung) return null;
      return composeHybrid(tiers, [], {
        limit: options.limit ?? DEFAULT_RESULT_LIMIT,
        select: options.select,
        rungFamilyOf: options.rungFamilyOf,
      });
    }

    // SEARCH-54: the rung runs only where its semantics can hold. A fields
    // restriction (title:) has no dense analogue — similarity is whole-document, so
    // the rung would leak off-title results into a title-restricted search — and an
    // identifier-shaped query (hex address, hash) has no meaning to embed: its dense
    // neighbourhood is just other identifiers. Both keep the keyword results, staged
    // when a stage opted in (the same shape as the confident branch above).
    if (options.fields?.length || isIdentifierQuery(tokenizeQueryUnstemmed(query))) {
      if (!options.select || !options.applySelectWithoutRung) return null;
      return composeHybrid(tiers, [], {
        limit: options.limit ?? DEFAULT_RESULT_LIMIT,
        select: options.select,
        rungFamilyOf: options.rungFamilyOf,
      });
    }

    // SEARCH-09 changes one keyword position only. The original dense query stays
    // byte-identical so the rest of the hybrid ranking cannot drift.
    const canonical = canonicalDenseQuery(query);
    if (!canonical) return null;

    reportDenseState(options.onDenseState, 'loading');
    const backend = await dense();
    const count = backend ? (isRemoteBackend(backend) ? backend.count : backend.store.manifest.count) : 0;
    if (!backend || count !== documents.length) {
      reportDenseState(options.onDenseState, 'unavailable');
      return null;
    }

    // Over-fetch so type/scope filtering still leaves a full rung.
    const types = options.types?.length ? new Set(options.types) : null;
    const admissible = (hit: DenseHit): boolean => {
      const document = documents[hit.row];
      if (!document) return false;
      if (types && !types.has(document.type)) return false;
      return options.includeId ? options.includeId(hit.row) : true;
    };

    const remote = isRemoteBackend(backend);
    let denseHits: DenseHit[];
    if (remote) {
      // The server dense route caps its limit at 50; the remote path keeps the
      // measured SEARCH-21 over-fetch until the route accepts filters or deeper lists.
      const unfiltered = await (backend as RemoteDenseBackend).search(canonical, HYBRID_RUNG_SIZE * 5);
      reportDenseState(options.onDenseState, 'available');
      denseHits = unfiltered.filter(admissible);
    } else {
      // SEARCH-44 (adopted 2026-09-04): cluster-first selection over the
      // full exact ranking — one representative per duplicate family, admissibility
      // checked during selection, rows the strict pass already shows skipped. No
      // window, so neither filter starvation nor family starvation can occur.
      // Replaces both the fixed top-50 window and the SEARCH-42 ladder on this path.
      const queryVector = await (backend as DenseBackend).embedder.embed(canonical);
      const fullRanking = (backend as DenseBackend).store.search(queryVector, documents.length);
      reportDenseState(options.onDenseState, 'available');
      const strictRows = new Set(tiers.strict.map((hit) => hit.id));
      const seenFamilies = new Set<string>();
      denseHits = [];
      for (const hit of fullRanking) {
        if (!admissible(hit) || strictRows.has(hit.row)) continue;
        const family = options.rungFamilyOf ? options.rungFamilyOf(hit.docNo) : hit.docNo;
        if (seenFamilies.has(family)) continue;
        seenFamilies.add(family);
        denseHits.push(hit);
        if (denseHits.length >= HYBRID_RUNG_SIZE) break;
      }
    }

    return composeHybrid(tiers, denseHits, {
      limit: options.limit ?? DEFAULT_RESULT_LIMIT,
      select: options.select,
      rungFamilyOf: options.rungFamilyOf,
    });
  } catch {
    reportDenseState(options.onDenseState, 'unavailable');
    // The dense path must never break search: any failure leaves keyword results standing.
    return null;
  }
}
