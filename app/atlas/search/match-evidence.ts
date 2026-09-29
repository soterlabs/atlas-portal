/**
 * SEARCH-53: per-hit match evidence — how each query word actually matched.
 *
 * The retrieval tier ("strict") admits exact, stemmed, prefix and typo-corrected
 * matches alike; the chip must not call them all "exact match" (external review,
 * batches 2+4). This classifier compares the query's content tokens with the hit's
 * matched index terms and reports the WEAKEST evidence across the query's words —
 * a hit is only as exact as its least exact word.
 *
 * Deterministic string comparison on data every hit already carries. Pure module.
 */
import { stemTerm } from './search-index';

export type MatchEvidence = 'exact' | 'word-form' | 'prefix' | 'typo';

/** Ordered strongest → weakest; a hit's evidence is the weakest of its words. */
const EVIDENCE_ORDER: MatchEvidence[] = ['exact', 'word-form', 'prefix', 'typo'];

export const EVIDENCE_LABEL: Record<MatchEvidence, string> = {
  exact: 'exact match',
  'word-form': 'word forms',
  prefix: 'prefix match',
  typo: 'typo-corrected',
};

/** How one query token relates to one matched index term. */
function tokenEvidence(token: string, term: string): MatchEvidence {
  if (term === token) return 'exact';
  // The index stores each word alongside its stem; a stem-level meeting point means
  // the document uses another form of the same word (compensated ↔ compensation).
  if (stemTerm(term) === stemTerm(token)) return 'word-form';
  if (term.startsWith(token)) return 'prefix';
  // The only remaining way the engine matches: fuzzy edit distance (a typo repair).
  return 'typo';
}

export interface HitEvidence {
  evidence: MatchEvidence;
  /** True when the match exists only in the generated expansion text — the reader's
   * words are not in the document itself; never labeled "exact match". */
  expansionOnly: boolean;
}

/**
 * Classifies a keyword hit. `queryTokens` are the query's unstemmed content tokens;
 * `terms` the hit's matched index terms; `fields` the index fields they matched in.
 * Query tokens that match no term (possible on OR-tier hits) are ignored — the
 * relaxed tier keeps its own "partial match" label for the missing-words fact.
 */
export function classifyHit(
  queryTokens: readonly string[],
  hit: { terms: readonly string[]; fields: readonly string[] },
): HitEvidence {
  let weakest: MatchEvidence = 'exact';
  for (const token of queryTokens) {
    let best: MatchEvidence | null = null;
    for (const term of hit.terms) {
      const evidence = tokenEvidence(token, term);
      if (best === null || EVIDENCE_ORDER.indexOf(evidence) < EVIDENCE_ORDER.indexOf(best)) {
        best = evidence;
      }
      if (best === 'exact') break;
    }
    if (best !== null && EVIDENCE_ORDER.indexOf(best) > EVIDENCE_ORDER.indexOf(weakest)) {
      weakest = best;
    }
  }
  const expansionOnly = hit.fields.length > 0 && hit.fields.every((field) => field === 'expansion');
  return { evidence: weakest, expansionOnly };
}

/**
 * SEARCH-53 (batch 4): the origin note shown when the visible snippet cannot carry a
 * highlight — the match lives somewhere the reader is not looking. Null when the
 * snippet or extras preview already shows marks.
 */
export function originNote(hit: { fields: readonly string[]; provenance?: string }): string | null {
  if (hit.provenance === 'rung') return null; // "similar" chip + expansion preview cover it
  const fields = new Set(hit.fields);
  if (fields.size === 0) return null;
  if (fields.has('content') || fields.has('extras')) return null; // marks are visible
  if (hit.fields.every((field) => field === 'expansion')) {
    return 'matches the document’s generated phrasing, not its own text';
  }
  if (fields.has('name')) return 'matches in the title';
  if (fields.has('doc_no')) return 'matches the document number';
  return null;
}
