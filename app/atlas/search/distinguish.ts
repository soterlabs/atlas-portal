/** How many breadcrumb segments a row's label may show. */
const MAX_SEGMENTS = 2;

/**
 * The breadcrumb segments that tell one row apart from the others currently on screen.
 *
 * A result row cannot show its whole path — a depth-13 document truncates long before the
 * segment that identifies it, which is why nine documents named "Maximum Exposure" all
 * read identically. So: look only at depths where the displayed paths disagree, and at
 * each such depth prefer the segment **fewest other rows share**.
 *
 * Rarity rather than depth is the selector, and the difference matters. Choosing the
 * deepest differing segments looks reasonable and fails: for `maximum exposure` every
 * instance row shares its deepest differing segments (`Parameters › Off-chain Operational
 * Parameters`) and they stay indistinguishable. The Prime name sits shallower — and is
 * rare, which is exactly the signal.
 *
 * Returns an empty array when nothing distinguishes the row: a single-result page, a page
 * whose paths are identical, or a document with no ancestors at all (the seven Scope
 * documents). Callers render no label in that case.
 */
export function distinguishingSegments(paths: string[][], index: number, max: number = MAX_SEGMENTS): string[] {
  const mine = paths[index];
  if (!mine || mine.length === 0 || paths.length < 2) return [];

  const depth = Math.max(...paths.map((path) => path.length));
  const candidates: Array<{ depth: number; segment: string; shared: number }> = [];

  for (let level = 0; level < depth; level += 1) {
    const atLevel = paths.map((path) => path[level] ?? '');
    if (new Set(atLevel).size <= 1) continue;

    const segment = mine[level];
    if (!segment) continue;

    candidates.push({ depth: level, segment, shared: atLevel.filter((value) => value === segment).length });
  }

  // Rarity first; on ties, the shallower segment. Measured over every census family name
  // (770 queries, 1,393 same-name groups in top-10s, 2026-08-31): shallow ties distinguish
  // 85.2% of groups vs 84.3% for deep ties, and fix the misleading case where two rows of
  // different length share a deep tail (`Definitions › Tau Definition` at shifted depths)
  // and would otherwise render identical labels for genuinely different documents. The one
  // group deep ties handled better is a family of byte-identical copies, where identical
  // labels mislead nobody.
  return candidates
    .sort((a, b) => a.shared - b.shared || a.depth - b.depth)
    .slice(0, max)
    .sort((a, b) => a.depth - b.depth)
    .map((candidate) => candidate.segment);
}
