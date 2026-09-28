import { describe, expect, it } from 'vitest';
import {
  type SegmentDeps,
  type SegmentDocInfo,
  type SegmentationCapture,
  buildCategories,
  labelCategory,
  segmentCandidates,
  summarizeGroups,
} from '../segmentation';

/** Deps over a fixture corpus; ids are array positions, vectors optional per doc. */
function makeDeps(docs: Array<SegmentDocInfo & { vector?: number[] }>, overrides?: Partial<SegmentDeps>): SegmentDeps {
  return {
    docOf: (id) => docs[id],
    vectorOf: docs.some((doc) => doc.vector)
      ? (id) => (docs[id].vector ? Float32Array.from(docs[id].vector!) : null)
      : undefined,
    ...overrides,
  };
}

const doc = (docNo: string, name: string, breadcrumb: string[] = [], vector?: number[]) => ({
  docNo,
  name,
  breadcrumb,
  vector,
});

describe('buildCategories', () => {
  it('groups candidates sharing a normalised name', () => {
    const deps = makeDeps([
      doc('A.1', 'Maximum  Exposure', ['Root', 'One']),
      doc('B.1', 'Unrelated', ['Root', 'Two']),
      doc('C.1', 'maximum exposure', ['Root', 'Three']),
    ]);
    const categories = buildCategories([0, 1, 2], deps);
    expect(categories.map((category) => category.positions)).toEqual([[0, 2], [1]]);
  });

  it('groups candidates under the same parent path, but not mere ancestors', () => {
    const deps = makeDeps([
      doc('A.1.1', 'Alpha', ['Root', 'Section']),
      doc('A.1.2', 'Beta', ['Root', 'Section']),
      doc('A.1', 'Section', ['Root']), // the parent itself: different breadcrumb, stays apart
    ]);
    const categories = buildCategories([0, 1, 2], deps);
    expect(categories.map((category) => category.positions)).toEqual([[0, 1], [2]]);
  });

  it('does not merge root documents on their empty parent key or empty names', () => {
    const deps = makeDeps([doc('A', 'Alpha', []), doc('B', 'Beta', []), doc('C', '', ['X']), doc('D', '', ['Y'])]);
    expect(buildCategories([0, 1, 2, 3], deps)).toHaveLength(4);
  });

  it('links by cosine similarity at the threshold, transitively (single link)', () => {
    const deps = makeDeps([
      doc('A', 'One', ['P1'], [1, 0]),
      doc('B', 'Two', ['P2'], [0.95, 0.31224]), // cos ≈ 0.95 with A
      doc('C', 'Three', ['P3'], [0.8, 0.6]), // cos ≈ 0.987 with B, ≈ 0.8 with A → joins via B
      doc('D', 'Four', ['P4'], [0, 1]), // orthogonal to A
    ]);
    const categories = buildCategories([0, 1, 2, 3], deps);
    expect(categories.map((category) => category.positions)).toEqual([[0, 1, 2], [3]]);
  });

  it('skips the cosine layer without vectors and orders categories by best rank', () => {
    const deps = makeDeps([
      doc('B.9', 'Solo', ['Elsewhere']),
      doc('A.1', 'Twin', ['Root']),
      doc('A.2', 'Twin', ['Root']),
    ]);
    const categories = buildCategories([0, 1, 2], deps);
    expect(categories.map((category) => category.positions)).toEqual([[0], [1, 2]]);
  });
});

describe('labelCategory', () => {
  const docs = [
    doc('A.1', 'Cap Automator', ['Atlas', 'Cap Automator']),
    doc('A.2', 'Cap Automator', ['Atlas', 'Cap Automator']),
    doc('B.1', 'ETH Parameters', ['Atlas', 'Rate Limits']),
    doc('B.2', 'USDS Parameters', ['Atlas', 'Rate Limits']),
    doc('C.1', 'Maximum Borrow Cap', ['Atlas', 'Spark']),
    doc('C.2', 'Maximum Supply Cap', ['Atlas', 'Lending']),
    doc('D.1', 'Something Else', ['Atlas', 'Other']),
  ];
  const deps = makeDeps(docs);
  const all = docs.map((_, id) => id);

  it('is empty for singletons — the row is its own label', () => {
    expect(labelCategory([6], all, deps)).toBe('');
  });

  it('uses the shared name when all members carry it', () => {
    expect(labelCategory([0, 1], all, deps)).toBe('Cap Automator');
  });

  it('falls back to the shared parent name', () => {
    expect(labelCategory([2, 3], all, deps)).toBe('Rate Limits');
  });

  it('falls back to contrastive keywords from member names', () => {
    const label = labelCategory([4, 5], all, deps);
    expect(label).toContain('maximum');
    expect(label.split(' ')).toHaveLength(2);
  });
});

describe('near-duplicate window members', () => {
  it('keeps same-name twins with distinct content visible — name reuse is not duplication', () => {
    // The measured Q10 case: two `Liquidation Threshold` rules under different
    // default-calculation processes, both primary-relevant. Same name, cosine 0.9.
    const docs = [
      doc('A.1', 'Liquidation Threshold', ['Probability Of Default'], [1, 0]),
      doc('B.1', 'Liquidation Threshold', ['Loss Given Default'], [0.9, 0.436]),
      doc('C.1', 'Other Topic', ['P3'], [0, 1]),
    ];
    const deps = makeDeps(docs);
    const permuted = segmentCandidates(
      docs.map((_, id) => ({ id })),
      { ...deps, topWindow: 3 },
    );
    expect(permuted.map((c) => c.id)).toEqual([0, 1, 2]); // both twins stay in the window
  });

  it('groups a near-identical-vector duplicate but keeps distinct category siblings visible', () => {
    const docs = [
      doc('A.1', 'Rule One', ['Parent'], [1, 0]),
      doc('A.2', 'Rule Two', ['Parent'], [0.999, 0.0447]), // cosine ≈ 0.999 with A.1: duplicate
      doc('A.3', 'Rule Three', ['Parent'], [0.9, 0.436]), // cosine 0.9: same category, distinct
    ];
    const deps = makeDeps(docs);
    const out = { categories: [] as ReturnType<typeof buildCategories>, allocation: [] as number[] };
    const permuted = segmentCandidates(
      docs.map((_, id) => ({ id })),
      { ...deps, topWindow: 3 },
      out,
    );
    expect(permuted.map((c) => c.id)).toEqual([0, 2, 1]);
    expect(out.categories).toHaveLength(1); // all three share the parent
    expect(out.allocation[0]).toBe(2); // two visible, the duplicate behind "+1 more"
  });
});

describe('summarizeGroups', () => {
  it('summarizes only categories that grouped members away, keyed by representative id', () => {
    const docs = [
      doc('A.1', 'Twin Rule', ['Parent']),
      doc('B.1', 'Solo', ['Elsewhere']),
      doc('A.2', 'Twin Rule Two', ['Parent']),
      ...Array.from({ length: 9 }, (_, i) => doc(`C.${i}`, `Filler ${i}`, [`F${i}`])),
      doc('A.3', 'Twin Rule Three', ['Parent']), // below the window: grouped away
    ];
    const deps = makeDeps(docs);
    const candidates = docs.map((_, id) => ({ id }));
    const capture: SegmentationCapture = { categories: [], allocation: [] };
    segmentCandidates(candidates, { ...deps, topWindow: 10 }, capture);
    const groups = summarizeGroups(candidates, capture);

    expect(groups).toHaveLength(1); // only the Parent category hid a member
    expect(groups[0].firstId).toBe(0); // keyed by the representative's id
    expect(groups[0].label).toBe('Parent');
    expect(groups[0].hidden.map((hit) => hit.id)).toEqual([12]);
  });
});

describe('tree-backbone segments (SEARCH-32)', () => {
  // A two-scope corpus: sections with per-asset rows, a parent-child pair, and a
  // sparse scope. Ids are array positions; candidates are subsets of these ids.
  const docs = [
    doc('A.1', 'The Stability Scope', []), // 0
    doc('A.1.1', 'Cap Automators', ['The Stability Scope']), // 1
    doc('A.1.1.1', 'Asset One Row', ['The Stability Scope', 'Cap Automators'], [1, 0]), // 2
    doc('A.1.1.2', 'Asset Two Row', ['The Stability Scope', 'Cap Automators'], [0.9, 0.436]), // 3
    doc('A.1.2', 'Aligned Delegates', ['The Stability Scope']), // 4
    doc('A.1.2.1', 'AD Compensation Cycle', ['The Stability Scope', 'Aligned Delegates']), // 5
    doc('A.2', 'Support Scope', []), // 6
    doc('A.2.1', 'Budget', ['Support Scope']), // 7
    doc('A.2.2', 'Maintenance', ['Support Scope'], [0.999, 0.0447]), // 8: near-dup of doc 2
  ];
  const parents = [null, 0, 1, 1, 0, 4, null, 6, 6];
  const treeDeps = (overrides?: Partial<SegmentDeps>): SegmentDeps => ({
    ...makeDeps(docs),
    parentIdOf: (id) => parents[id],
    ...overrides,
  });

  const categoriesFor = (candidateIds: number[], deps: SegmentDeps) => {
    const capture: SegmentationCapture = { categories: [], allocation: [] };
    segmentCandidates(
      candidateIds.map((id) => ({ id })),
      deps,
      capture,
    );
    return capture.categories;
  };

  it('anchors sibling rows at their section, labeled with its real name', () => {
    const categories = categoriesFor([2, 3, 7], treeDeps({ vectorOf: undefined }));
    expect(categories.map((category) => category.label)).toEqual(['Cap Automators', '']);
    expect(categories[0].positions).toEqual([0, 1]);
  });

  it('keeps a parent-and-child result in one segment anchored at the parent', () => {
    const categories = categoriesFor([4, 5, 7], treeDeps({ vectorOf: undefined }));
    expect(categories[0].positions).toEqual([0, 1]);
    expect(categories[0].label).toBe('Aligned Delegates');
  });

  it('falls back to the scope when results share nothing deeper, and keeps cross-scope loners apart', () => {
    const coarse = categoriesFor([7, 8], treeDeps({ vectorOf: undefined }));
    expect(coarse).toHaveLength(1);
    expect(coarse[0].label).toBe('Support Scope');

    const loners = categoriesFor([2, 7], treeDeps({ vectorOf: undefined }));
    expect(loners).toHaveLength(2);
    expect(loners.map((category) => category.label)).toEqual(['', '']);
  });

  it('joins a cross-branch near-duplicate into the earlier segment', () => {
    // Doc 8 lives in Support Scope but is a ≥0.98 twin of doc 2 (Cap Automators).
    const categories = categoriesFor([2, 3, 8], treeDeps());
    expect(categories).toHaveLength(1);
    expect(categories[0].label).toBe('Cap Automators');
  });

  it('joins cross-branch name-family copies, and never hides same-name window twins', () => {
    // Docs 5 and 7 share nothing tree-wise; give doc 7 the same name as doc 5.
    const namedDocs = docs.map((entry, id) => (id === 7 ? { ...entry, name: docs[5].name } : entry));
    const namedDeps: SegmentDeps = {
      ...makeDeps(namedDocs),
      parentIdOf: (id) => parents[id],
      vectorOf: undefined,
    };
    const capture: SegmentationCapture = { categories: [], allocation: [] };
    const permuted = segmentCandidates([{ id: 5 }, { id: 7 }], namedDeps, capture);
    expect(capture.categories).toHaveLength(1); // one name-family segment
    // Both are window members with distinct content: grouped, but both visible.
    expect(permuted.map((c) => c.id)).toEqual([5, 7]);
    expect(capture.allocation[0]).toBe(2);
  });

  it('never reorders the top window — interleaved categories keep original rank order', () => {
    // Positions 0,2 share a section; 1,3 share another. Category blocks would emit
    // [0,2,1,3]; the measured contract is the original [0,1,2,3].
    const interleaved = [
      doc('S.1', 'Section One', []), // 0 (ancestor, not a candidate)
      doc('S.2', 'Section Two', []), // 1 (ancestor, not a candidate)
      doc('S.1.1', 'Alpha', ['Section One']), // 2
      doc('S.2.1', 'Beta', ['Section Two']), // 3
      doc('S.1.2', 'Gamma', ['Section One']), // 4
      doc('S.2.2', 'Delta', ['Section Two']), // 5
    ];
    const interleavedParents = [null, null, 0, 1, 0, 1];
    const permuted = segmentCandidates([{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], {
      ...makeDeps(interleaved),
      parentIdOf: (id) => interleavedParents[id],
      topWindow: 4,
    });
    expect(permuted.map((c) => c.id)).toEqual([2, 3, 4, 5]);
  });

  it('runs the legacy layered union when parentIdOf is absent', () => {
    // Same-parent breadcrumbs still group without any tree information.
    const categories = categoriesFor([2, 3, 7], { ...makeDeps(docs), vectorOf: undefined });
    expect(categories[0].positions).toEqual([0, 1]);
  });
});

describe('segmentCandidates', () => {
  it('returns a permutation: spine first, grouped-away members after, nothing lost', () => {
    // Ten same-parent siblings dominating, one distinct intent at the tail.
    const docs = [
      ...Array.from({ length: 10 }, (_, i) => doc(`A.${i}`, `Asset ${i}`, ['Atlas', 'Cap Automator'])),
      doc('Z.1', 'Maximum Exposure Tolerance', ['Atlas', 'Risk']),
    ];
    const deps = makeDeps(docs);
    const candidates = docs.map((_, id) => ({ id }));
    const out = { categories: [] as ReturnType<typeof buildCategories>, allocation: [] as number[] };
    const permuted = segmentCandidates(candidates, deps, out);

    expect([...permuted].map((c) => c.id).sort((a, b) => a - b)).toEqual(candidates.map((c) => c.id));
    expect(out.categories).toHaveLength(2);
    // All ten window members of the dominant category stay visible (the gate
    // contract); the buried intent surfaces immediately after them, not @58.
    expect(out.allocation[0]).toBe(10);
    expect(permuted.findIndex((c) => c.id === 10)).toBe(10);
  });

  it('promotes only categories whose best hit is inside the promotion depth', () => {
    // Docs 0 and 4 share a name; doc 5 is a distinct singleton at the tail.
    const docs = [
      doc('A', 'Twin', ['P0']),
      doc('B', 'One', ['P1']),
      doc('C', 'Two', ['P2']),
      doc('D', 'Three', ['P3']),
      doc('E', 'Twin', ['P4']),
      doc('F', 'Deep', ['P5']),
    ];
    const deps = makeDeps(docs);
    const candidates = docs.map((_, id) => ({ id }));

    // Depth 6: every category is promoted — doc 5's spine row jumps the hidden twin.
    const wide = segmentCandidates(candidates, { ...deps, topWindow: 2, promotionDepth: 6 });
    expect(wide.map((c) => c.id)).toEqual([0, 1, 2, 3, 5, 4]);

    // Depth 4: doc 5's category (best @5) is not promoted — the deep tail keeps its
    // original order, and the allocation marks the category as unpromoted.
    const out = { categories: [] as ReturnType<typeof buildCategories>, allocation: [] as number[] };
    const bounded = segmentCandidates(candidates, { ...deps, topWindow: 2, promotionDepth: 4 }, out);
    expect(bounded.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.allocation[out.categories.findIndex((c) => c.positions[0] === 5)]).toBe(0);
  });

  it('is the identity on empty input and near-identity when every candidate is its own category', () => {
    const deps = makeDeps([doc('A', 'One', ['P1']), doc('B', 'Two', ['P2']), doc('C', 'Three', ['P3'])]);
    expect(segmentCandidates([], deps)).toEqual([]);
    const candidates = [{ id: 0 }, { id: 1 }, { id: 2 }];
    expect(segmentCandidates(candidates, deps).map((c) => c.id)).toEqual([0, 1, 2]);
  });
});
