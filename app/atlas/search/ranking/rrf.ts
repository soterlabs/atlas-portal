/**
 * SEARCH-40: generic reciprocal-rank fusion.
 *
 * Fuses ranked lists without comparing raw scores: an item found at 1-based rank r
 * in a list contributes 1/(k + r); contributions sum across lists (Cormack et al.,
 * 2009; k = 60 by convention). Rank-based, so incomparable score scales fuse
 * safely — the property that makes RRF attractive for multi-route arms such as the
 * literal-plus-vocabulary-query idea (zvec-grep analysis, I-6).
 *
 * Ties break deterministically, mirroring zvec-grep's chain: fused score desc →
 * best single rank asc → earliest list index → id order.
 *
 * Note: SEARCH-21 measured RRF against the shipped gated cascade for engine fusion
 * and it LOST (0.5575 vs 0.5753, 8 gate failures) — this utility exists for new
 * arms, not to revisit that verdict.
 */

export interface FusedItem<Id extends string | number> {
  id: Id;
  score: number;
  /** Best (lowest) 1-based rank the item achieved in any list. */
  bestRank: number;
  /** Index of the first list that contained the item. */
  firstList: number;
}

export function rrfFuse<Id extends string | number>(lists: ReadonlyArray<readonly Id[]>, k = 60): Array<FusedItem<Id>> {
  if (k <= 0) throw new Error('k must be positive');
  const items = new Map<Id, FusedItem<Id>>();
  lists.forEach((list, listIndex) => {
    list.forEach((id, position) => {
      const rank = position + 1;
      const existing = items.get(id);
      if (!existing) {
        items.set(id, { id, score: 1 / (k + rank), bestRank: rank, firstList: listIndex });
      } else {
        existing.score += 1 / (k + rank);
        if (rank < existing.bestRank) existing.bestRank = rank;
      }
    });
  });
  return [...items.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.bestRank - b.bestRank ||
      a.firstList - b.firstList ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
