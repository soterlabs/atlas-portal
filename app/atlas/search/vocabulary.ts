/**
 * SEARCH-09: a deliberately small, evidence-backed reader → Atlas vocabulary map.
 *
 * `cap` and `limit` are not global synonyms for `tolerance`: supply caps, borrow caps,
 * Max Cap and Exposure Limit are separate Atlas concepts. A rule therefore identifies
 * one adjudicated target and a conservative maximum promotion rank. Retrieval keeps
 * the literal ranking and promotes only that target when it is below the ticket's bar.
 */

export interface AtlasVocabularyReplacement {
  /** The reader's word, preserving the spelling/case they entered. */
  readerTerm: string;
  /** The Atlas term used for retrieval. */
  atlasTerm: 'tolerance';
}

export interface AtlasVocabularyQuery {
  /** Original query, unchanged for display and history. */
  originalQuery: string;
  /** Companion query used to identify the adjudicated Atlas-vocabulary result. */
  retrievalQuery: string;
  /** The only document this rule is allowed to promote. */
  targetDocNo: string;
  /** One-based boundary: results above this rank are sacrosanct. */
  promotionRank: number;
  replacements: AtlasVocabularyReplacement[];
}

export const MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO = 'A.2.2.10.1.1.1.2.1.7';

/**
 * Recognise only `maximum cap(s)` and `exposure cap(s)|limit(s)`. `max cap`
 * deliberately stays literal because the Atlas has a document named Max Cap Definition.
 *
 * Examples:
 * - `maximum cap` → `maximum tolerance`
 * - `exposure limit` → `exposure tolerance`
 * - `max cap`, `supply cap`, `borrow cap`, `rate limit` → unchanged
 */
export function mapAtlasVocabulary(query: string): AtlasVocabularyQuery | null {
  // Keyed by the folded reader word so `maximum cap and exposure cap` discloses
  // “cap” → “tolerance” once rather than repeating one substitution per occurrence.
  const replacements = new Map<string, AtlasVocabularyReplacement>();
  let promotionRank = Number.POSITIVE_INFINITY;
  const retrievalQuery = query.replace(
    /(?<![\p{L}\p{N}_-])(maximum|exposure)\s+(caps?|limits?)(?![\p{L}\p{N}_-])/giu,
    (match, context: string, readerTerm: string) => {
      // `maximum limit` is not part of the adjudicated reader vocabulary. Do not
      // extrapolate beyond measured phrases merely because the regex can see it.
      if (context.toLowerCase() === 'maximum' && readerTerm.toLowerCase().startsWith('limit')) return match;
      const key = readerTerm.toLowerCase();
      if (!replacements.has(key)) replacements.set(key, { readerTerm, atlasTerm: 'tolerance' });
      promotionRank = Math.min(promotionRank, context.toLowerCase() === 'maximum' ? 10 : 20);
      return `${context} tolerance`;
    },
  );

  return replacements.size > 0
    ? {
        originalQuery: query,
        retrievalQuery,
        targetDocNo: MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO,
        promotionRank,
        replacements: [...replacements.values()],
      }
    : null;
}
