/**
 * Result segmentation (SEARCH-29): a category-diverse top of the result list.
 *
 * The `maximum cap` adjudication showed the failure mode this addresses: 58 candidates
 * collapsing into ~15 real categories, with one whole intent (the exceedance rule)
 * pushed off-screen by repetition from others. Segmentation spends the visible slots
 * across categories — the page stays a flat list of documents (the agreed UX
 * decisions, 2026-09-01); categories are latent, expressed only as light separation
 * and an inline "see more similar results" per category.
 *
 * Category formation has two backbones (SEARCH-32: "the tree organizes, similarity
 * deduplicates"):
 *
 * **Tree backbone** — active when `parentIdOf` is supplied. Categories are segments of
 * the *induced result tree*: each candidate anchors at its deepest ancestor-or-self
 * whose induced subtree holds at least two candidates (per-asset siblings anchor at
 * their section; a parent-and-child result pair anchors at the parent; results sharing
 * only a Scope anchor there — coarse but honest; cross-scope loners stay singletons).
 * Labels are the anchor's real Atlas name, replacing keyword-contrast labels (measured
 * weak: «maximum usdc»). Similarity keeps exactly one job: a candidate at cosine ≥
 * SEGMENT_DUPLICATE_COSINE to an earlier candidate joins that candidate's segment —
 * cross-branch copies are the same information wherever the tree puts them.
 *
 * **Legacy layered union** — without `parentIdOf` (and for measured comparison):
 * single-link over (1) same normalised name, (2) same parent path, (3) cosine ≥
 * SEGMENT_COSINE_THRESHOLD when vectors are available.
 *
 * Both backbones group near-duplicates where SEARCH-22's collapse dropped them —
 * dropping made deep gate secondaries unretrievable once the stage ran on the
 * confident-keyword path, grouping keeps every candidate in the permutation. Inside
 * the top window, a member whose embedding cosine to an already-visible member of its
 * category reaches SEGMENT_DUPLICATE_COSINE — the census duplicate threshold — is
 * grouped away exactly as collapse would have hidden it; distinct category-mates
 * (siblings answering the same query differently, even under a shared reused name)
 * stay visible.
 *
 * The selection-stage output is a permutation of the candidates (SEARCH-21's seam
 * contract): first the visible spine — every top-window member (grouped into category
 * blocks, never hidden) plus one representative per category whose best hit is within
 * SEGMENT_PROMOTION_DEPTH — then every remaining candidate in original order.
 * Candidates deeper than the promotion depth are not re-ranked at all. Evaluation
 * measures exactly this permutation; the UI renders the spine with the grouped-away
 * members behind inline expansion.
 */

export const SEGMENT_COSINE_THRESHOLD = 0.85;
/** Members ranked inside this window are always visible (the protected "top-10"). */
export const SEGMENT_TOP_WINDOW = 10;
/**
 * Only categories whose best hit ranks inside this depth are promoted onto the spine;
 * everything deeper keeps its original order. 60 covers the measured exhibit (the
 * `maximum cap` tolerance rule enters at 58). Promoting every category regardless of
 * depth re-ranked the deep tail and failed three gate criteria — a ≤100 secondary
 * pushed past the cut, a ≤50 natural-language target displaced to 93.
 */
export const SEGMENT_PROMOTION_DEPTH = 60;
/**
 * A window member at or above this cosine to an already-visible category-mate is a
 * near-duplicate: grouped away from the window, like the SEARCH-22 collapse it
 * replaces. Matches the census duplicate-family threshold; the comparison runs on the
 * quantised shipped vectors, which is the documented approximation. Without the rule,
 * census duplicates re-entered the top 10 and distinct-families@10 regressed
 * (9.85 → 9.80 on the dev set). Cosine only, deliberately: name equality is NOT a
 * duplicate signal — Atlas reuses parameter names under different processes (two
 * `Liquidation Threshold` rules, one per default-calculation branch, are both judged
 * primary for `collateral liquidation`; a name shortcut hid one and failed the gate).
 */
export const SEGMENT_DUPLICATE_COSINE = 0.98;

export interface SegmentDocInfo {
  docNo: string;
  name: string;
  breadcrumb: string[];
}

export interface SegmentDeps {
  /** Must resolve any document id — candidates and their ancestors alike. */
  docOf: (id: number) => SegmentDocInfo;
  /** Dequantised document vector, or null when unavailable; layer 3 is skipped without it. */
  vectorOf?: (id: number) => Float32Array | null;
  /**
   * The document's tree parent (`FlatAtlasDocument.parentId`, SEARCH-31). Supplying it
   * switches category formation to the tree backbone (SEARCH-32); without it the
   * legacy layered union runs — the graceful degradation and the measured baseline.
   */
  parentIdOf?: (id: number) => number | null;
  cosineThreshold?: number;
  topWindow?: number;
  promotionDepth?: number;
  duplicateCosine?: number;
}

export interface Category {
  /** Candidate positions (0-based ranks), ascending — the first is the category's best. */
  positions: number[];
  label: string;
}

function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function parentKey(breadcrumb: string[]): string {
  return breadcrumb.map(normalizeName).join('\u0000');
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d += 1) {
    dot += a[d] * b[d];
    na += a[d] * a[d];
    nb += b[d] * b[d];
  }
  const norm = Math.sqrt(na * nb);
  return norm === 0 ? 0 : dot / norm;
}

/** Union-find over candidate positions. */
function unionFind(size: number): { find: (x: number) => number; union: (a: number, b: number) => void } {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  return { find, union: (a, b) => void (parent[find(a)] = find(b)) };
}

/**
 * Groups candidates into categories (ordered by their best member's rank) using the
 * three structural layers. Pure; O(n²) in the candidate count for the cosine layer,
 * which at ≤ 100 candidates × 384 dims is a few milliseconds.
 */
export function buildCategories(ids: number[], deps: SegmentDeps): Category[] {
  const { find, union } = unionFind(ids.length);
  const threshold = deps.cosineThreshold ?? SEGMENT_COSINE_THRESHOLD;

  const byName = new Map<string, number>();
  const byParent = new Map<string, number>();
  ids.forEach((id, position) => {
    const doc = deps.docOf(id);
    const name = normalizeName(doc.name);
    if (name) {
      const first = byName.get(name);
      if (first === undefined) byName.set(name, position);
      else union(first, position);
    }
    const parent = parentKey(doc.breadcrumb);
    if (parent) {
      const first = byParent.get(parent);
      if (first === undefined) byParent.set(parent, position);
      else union(first, position);
    }
  });

  if (deps.vectorOf) {
    const vectors = ids.map((id) => deps.vectorOf!(id));
    for (let a = 0; a < ids.length; a += 1) {
      if (!vectors[a]) continue;
      for (let b = a + 1; b < ids.length; b += 1) {
        if (!vectors[b] || find(a) === find(b)) continue;
        if (cosine(vectors[a]!, vectors[b]!) >= threshold) union(a, b);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  ids.forEach((_, position) => {
    const root = find(position);
    const members = byRoot.get(root);
    if (members) members.push(position);
    else byRoot.set(root, [position]);
  });
  return [...byRoot.values()]
    .map((positions) => positions.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .map((positions) => ({
      positions,
      label: labelCategory(
        positions.map((p) => ids[p]),
        ids,
        deps,
      ),
    }));
}

/**
 * A structural, never-generated label: the shared document name; else the shared
 * parent's name; else the most member-distinctive name keywords (contrast against all
 * candidates); empty for singletons (the row is its own label).
 */
export function labelCategory(memberIds: number[], allIds: number[], deps: SegmentDeps): string {
  if (memberIds.length < 2) return '';
  const docs = memberIds.map((id) => deps.docOf(id));

  const names = new Set(docs.map((doc) => normalizeName(doc.name)));
  if (names.size === 1) return docs[0].name;

  const parents = new Set(docs.map((doc) => parentKey(doc.breadcrumb)));
  if (parents.size === 1 && docs[0].breadcrumb.length > 0) {
    return docs[0].breadcrumb[docs[0].breadcrumb.length - 1];
  }

  const tokenCount = (ids: number[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      for (const token of new Set(
        normalizeName(deps.docOf(id).name)
          .split(' ')
          .filter((t) => t.length > 2),
      )) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    return counts;
  };
  const inMembers = tokenCount(memberIds);
  const everywhere = tokenCount(allIds);
  const distinctive = [...inMembers.entries()]
    .map(([token, count]) => ({
      token,
      score: count / memberIds.length - (everywhere.get(token) ?? 0) / allIds.length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((entry) => entry.token);
  return distinctive.join(' ');
}

/** Quantised-vector cosine at the census duplicate threshold; never name equality. */
function isNearDuplicate(aId: number, bId: number, deps: SegmentDeps, threshold: number): boolean {
  const vectorA = deps.vectorOf?.(aId);
  const vectorB = deps.vectorOf?.(bId);
  return !!vectorA && !!vectorB && cosine(vectorA, vectorB) >= threshold;
}

/**
 * SEARCH-32: segments of the induced result tree. Each candidate anchors at its
 * deepest ancestor-or-self whose induced subtree holds ≥ 2 candidates (a real, named
 * place in the Atlas); candidates sharing no real ancestor with anyone stay
 * singletons. A candidate at duplicate cosine to an earlier candidate joins that
 * candidate's segment regardless of tree position — cross-branch copies are one piece
 * of information. Labels are the anchor's name for multi-member segments.
 */
function buildTreeSegments(ids: number[], deps: SegmentDeps): Category[] {
  const parentIdOf = deps.parentIdOf!;
  const duplicateCosine = deps.duplicateCosine ?? SEGMENT_DUPLICATE_COSINE;

  // Pass 1: how many candidates live in each node's induced subtree (self included).
  const subtreeCandidates = new Map<number, number>();
  const chains = ids.map((id) => {
    const chain: number[] = [];
    // Defensive bound mirrors tree-context: a corrupt parent cycle must not hang.
    for (let current: number | null = id; current !== null && chain.length <= 10_000; current = parentIdOf(current)) {
      chain.push(current);
      subtreeCandidates.set(current, (subtreeCandidates.get(current) ?? 0) + 1);
    }
    return chain;
  });

  // Pass 2: anchor each candidate at the deepest node on its chain shared with others.
  const anchorOf = chains.map((chain) => chain.find((node) => (subtreeCandidates.get(node) ?? 0) >= 2));

  // Pass 3: cross-branch copies join the segment of their first earlier twin (rank
  // order) — by exact normalised name (the census name-family case: 19 `Maximum
  // Exposure` copies, one per venue subtree; without this joiner they fragmented the
  // spine and pushed the maxcap exhibit from 17 to 38) or by duplicate cosine.
  // Joining never hides: window members of a joined segment all stay visible (the Q10
  // `Liquidation Threshold` twins), so name equality is safe here even though it is
  // banned as a *hiding* signal.
  const segmentKey: (string | number)[] = ids.map((id, position) => anchorOf[position] ?? `singleton-${id}`);
  const firstByName = new Map<string, number>();
  for (let later = 0; later < ids.length; later += 1) {
    const name = normalizeName(deps.docOf(ids[later]).name);
    const earlierByName = name ? firstByName.get(name) : undefined;
    if (earlierByName !== undefined) {
      segmentKey[later] = segmentKey[earlierByName];
      continue;
    }
    if (name) firstByName.set(name, later);
    if (deps.vectorOf) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (isNearDuplicate(ids[earlier], ids[later], deps, duplicateCosine)) {
          segmentKey[later] = segmentKey[earlier];
          break;
        }
      }
    }
  }

  const byKey = new Map<string | number, number[]>();
  ids.forEach((_, position) => {
    const key = segmentKey[position];
    const members = byKey.get(key);
    if (members) members.push(position);
    else byKey.set(key, [position]);
  });
  return [...byKey.entries()]
    .map(([key, positions]) => ({ key, positions: positions.sort((a, b) => a - b) }))
    .sort((a, b) => a.positions[0] - b.positions[0])
    .map(({ key, positions }) => ({
      positions,
      label: positions.length > 1 && typeof key === 'number' ? deps.docOf(key).name : '',
    }));
}

/**
 * The selection stage: a permutation of the candidates — the visible spine first
 * (promoted categories in rank order), then every remaining candidate in original
 * order. Per promoted category the spine shows: every top-window member that is not a
 * near-duplicate of an already-visible member (the first cut of this rule —
 * score-proportional slots with a per-category cap, design decision 2 — hid gate
 * primaries and failed 7 of 53 criteria; window members may only be grouped away when
 * they are near-duplicates), or its single best member when none rank in the window.
 * A category is promoted only when its best member ranks inside the promotion depth;
 * an allocation of 0 in `categoriesOut` marks an unpromoted category (its members are
 * simply not re-ranked). `categoriesOut`, when provided, receives the built categories
 * and allocation for rendering ("see more similar results").
 */
export function segmentCandidates<T extends { id: number }>(
  candidates: T[],
  deps: SegmentDeps,
  categoriesOut?: SegmentationCapture,
): T[] {
  if (candidates.length === 0) return candidates;
  const ids = candidates.map((candidate) => candidate.id);
  const window = deps.topWindow ?? SEGMENT_TOP_WINDOW;
  const depth = deps.promotionDepth ?? SEGMENT_PROMOTION_DEPTH;
  const duplicateCosine = deps.duplicateCosine ?? SEGMENT_DUPLICATE_COSINE;
  const categories = deps.parentIdOf ? buildTreeSegments(ids, deps) : buildCategories(ids, deps);

  const visiblePositions = new Set<number>();
  const promotedReps: number[] = [];
  const allocation = categories.map(() => 0);
  // Emitted positions per category — duplicate skips make them non-contiguous, so the
  // renderer cannot reconstruct them from the allocation count alone.
  const emittedByCategory: number[][] = categories.map(() => []);
  categories.forEach((category, index) => {
    if (category.positions[0] >= depth) return; // beyond the promotion depth: untouched
    const emitted = emittedByCategory[index];
    for (const position of category.positions) {
      if (position >= window && emitted.length > 0) break;
      if (
        position < window &&
        emitted.some((earlier) => isNearDuplicate(ids[earlier], ids[position], deps, duplicateCosine))
      ) {
        continue; // a near-duplicate of a visible member: grouped away, kept in the tail
      }
      emitted.push(position);
      if (position >= window) break; // the single below-window representative
    }
    allocation[index] = emitted.length;
    for (const position of emitted) {
      visiblePositions.add(position);
      if (position >= window) promotedReps.push(position);
    }
  });

  // The top window is sacrosanct (SEARCH-32 measurement): emitting window members in
  // category-block order slid judged answers down inside the top 10 — the
  // instance-to-rule class went CI-negative (a five-copy `Maximum Exposure` block
  // pushed its rule from 3 to 6). Visible order is therefore: window members in their
  // ORIGINAL rank order (grouping shows as labels and "+N more", never as reordering),
  // then the promoted below-window representatives in category order.
  const visible: T[] = [];
  for (let position = 0; position < candidates.length && position < window; position += 1) {
    if (visiblePositions.has(position)) visible.push(candidates[position]);
  }
  for (const position of promotedReps) visible.push(candidates[position]);

  if (categoriesOut) {
    categoriesOut.categories = categories;
    categoriesOut.allocation = allocation;
    categoriesOut.visible = emittedByCategory;
  }

  const rest: T[] = [];
  for (let position = 0; position < candidates.length; position += 1) {
    if (!visiblePositions.has(position)) rest.push(candidates[position]);
  }
  return [...visible, ...rest];
}

/** What `segmentCandidates` built, for rendering: categories, slots, emitted positions. */
export interface SegmentationCapture {
  categories: Category[];
  allocation: number[];
  /** Positions actually emitted onto the spine, per category (set by segmentCandidates). */
  visible?: number[][];
}

/** One rendered group: its representative row's id, its label, its grouped-away members. */
export interface SegmentGroupSummary<T> {
  /** id of the group's first visible row (the category representative). */
  firstId: number;
  label: string;
  /** Members grouped away from the list, best-first — the inline "+N more" content. */
  hidden: T[];
}

/**
 * The UI-facing view of a segmentation pass: one entry per category that actually
 * grouped members away, keyed by its representative's id (row indices shift once a
 * renderer filters or cuts the permutation; ids do not).
 */
export function summarizeGroups<T extends { id: number }>(
  candidates: T[],
  capture: SegmentationCapture,
): SegmentGroupSummary<T>[] {
  const groups: SegmentGroupSummary<T>[] = [];
  capture.categories.forEach((category, index) => {
    const visible = capture.visible?.[index];
    if (!visible || visible.length === 0) return; // unpromoted: members were not re-ranked
    if (category.positions.length === visible.length) return; // nothing grouped away
    const visibleSet = new Set(visible);
    groups.push({
      firstId: candidates[visible[0]].id,
      label: category.label,
      hidden: category.positions
        .filter((position) => !visibleSet.has(position))
        .map((position) => candidates[position]),
    });
  });
  return groups;
}
