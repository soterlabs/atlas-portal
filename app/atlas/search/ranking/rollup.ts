/**
 * SEARCH-40: fragment-score → document-score rollups.
 *
 * When retrieval scores fragments (SEARCH-41), these pure functions aggregate a
 * document's fragment scores into one document score. Three candidate semantics,
 * compared by measurement before any of them can ship:
 *
 *  - `maxPool` — the document scores as its best-matching fragment. The direct
 *    attack on the whole-document-averaging failure (paraphrase, instance-to-rule).
 *  - `topKWeighted` — max + λ·second-best: rewards a second matching passage
 *    without letting long documents win by mass.
 *  - `rrfOverFragments` — rank-based consensus over the global fragment ranking,
 *    `Σ 1/(K + rank)` per fragment of the document (K = 60 by convention).
 *
 * Pure: no I/O, no engine imports.
 */

export interface FragmentScore {
  /** The parent document's id (row in the flattened corpus). */
  docId: number;
  /** Similarity score of one fragment of that document. */
  score: number;
}

/** Deterministic order: score desc, then input position asc. Input is never mutated. */
function sortedByScore(hits: readonly FragmentScore[]): FragmentScore[] {
  return hits
    .map((hit, position) => ({ hit, position }))
    .sort((a, b) => b.hit.score - a.hit.score || a.position - b.position)
    .map((entry) => entry.hit);
}

/** Document score = its best fragment score. */
export function maxPool(hits: readonly FragmentScore[]): Map<number, number> {
  const byDoc = new Map<number, number>();
  for (const { docId, score } of hits) {
    const best = byDoc.get(docId);
    if (best === undefined || score > best) byDoc.set(docId, score);
  }
  return byDoc;
}

/** Document score = best + λ·second-best (0 when the document has one fragment hit). */
export function topKWeighted(hits: readonly FragmentScore[], lambda: number): Map<number, number> {
  if (lambda < 0 || lambda > 1) throw new Error('lambda must be in [0, 1]');
  const top2 = new Map<number, [number, number]>();
  for (const { docId, score } of hits) {
    const pair = top2.get(docId);
    if (!pair) top2.set(docId, [score, Number.NEGATIVE_INFINITY]);
    else if (score > pair[0]) top2.set(docId, [score, pair[0]]);
    else if (score > pair[1]) top2.set(docId, [pair[0], score]);
  }
  const byDoc = new Map<number, number>();
  for (const [docId, [best, second]] of top2) {
    byDoc.set(docId, best + (Number.isFinite(second) ? lambda * second : 0));
  }
  return byDoc;
}

/**
 * Document score = Σ 1/(K + rank) over the document's fragments in the GLOBAL
 * fragment ranking (1-based; deterministic order as in `sortedByScore`).
 */
export function rrfOverFragments(hits: readonly FragmentScore[], k = 60): Map<number, number> {
  if (k <= 0) throw new Error('k must be positive');
  const byDoc = new Map<number, number>();
  sortedByScore(hits).forEach(({ docId }, index) => {
    byDoc.set(docId, (byDoc.get(docId) ?? 0) + 1 / (k + index + 1));
  });
  return byDoc;
}

/** Render a rollup result as a ranked list: score desc, then docId asc (deterministic). */
export function rankDocuments(byDoc: ReadonlyMap<number, number>): Array<{ docId: number; score: number }> {
  return [...byDoc.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score || a.docId - b.docId);
}
