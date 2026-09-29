/** How many scope chips to offer at once. */
const MAX_CHIPS = 6;

/**
 * The ancestors worth offering as filters for the current result set.
 *
 * A chip is useful only when it *splits* what is on screen. Ranking ancestors by
 * frequency — the obvious rule — produces chips that cannot filter anything: for
 * `off-chain parameters` the three most common ancestors are each present in 100 of 100
 * results, so selecting one changes nothing (spec §3.4).
 *
 * An ancestor therefore qualifies when it covers at least two results but not all of
 * them, and the ones closest to an even split lead, because they narrow the most. Ties
 * break alphabetically so the row is stable across renders.
 */
export function scopeChips(paths: string[][], max: number = MAX_CHIPS): string[] {
  const total = paths.length;
  if (total < 2) return [];

  const coverage = new Map<string, number>();
  for (const path of paths) {
    // A repeated ancestor within one path still counts once.
    for (const ancestor of new Set(path)) coverage.set(ancestor, (coverage.get(ancestor) ?? 0) + 1);
  }

  return [...coverage.entries()]
    .filter(([, count]) => count >= 2 && count < total)
    .sort((a, b) => Math.abs(total / 2 - a[1]) - Math.abs(total / 2 - b[1]) || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([ancestor]) => ancestor);
}
