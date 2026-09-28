import { describe, expect, it } from 'vitest';
import { distinguishingSegments } from '../distinguish';

describe('distinguishingSegments', () => {
  const paths = [
    ['Agent Scope', 'Artifacts', 'Spark', 'Parameters'],
    ['Agent Scope', 'Artifacts', 'Grove', 'Parameters'],
    ['Agent Scope', 'Artifacts', 'Osero', 'Parameters'],
    ['Support Scope', 'Primitives', 'Diamond PAU', 'Definitions'],
  ];

  it('picks the segment fewest other rows share', () => {
    // "Agent Scope" differs from row 4 but is shared by three rows; the Prime name is
    // unique to each, so it identifies the row and the scope does not.
    expect(distinguishingSegments(paths, 0)).toContain('Spark');
    expect(distinguishingSegments(paths, 1)).toContain('Grove');
    expect(distinguishingSegments(paths, 2)).toContain('Osero');
  });

  it('gives every row a different label when the paths differ', () => {
    const labels = paths.map((_, i) => distinguishingSegments(paths, i).join(' › '));
    expect(new Set(labels).size).toBe(paths.length);
  });

  it('renders the chosen segments in path order, not by rarity', () => {
    // Row 4's segments are all equally rare (unique), so the two shallowest win the tie
    // and must come out in path order. The plan's original assertion compared indexOf
    // results that could both be -1; this pins the actual segments.
    expect(distinguishingSegments(paths, 3)).toEqual(['Support Scope', 'Primitives']);
  });

  it('labels rows differently when a shared tail sits at different depths (Tau shape)', () => {
    // Two documents named alike end in the same `Definitions › Tau Definition` tail, but
    // their paths differ in length, so the tail sits at shifted levels. Per-level rarity
    // with a deep tie-break rendered both as "Definitions › Tau Definition"; the shallow
    // tie-break picks the segments that actually differ.
    const tau = [
      ['Stability', 'Endgame Measures', 'Bounded Module', 'Definitions', 'Tau Definition'],
      ['Protocol', 'Staking', 'Borrowing', 'Bounded Module', 'Definitions', 'Tau Definition'],
    ];
    const labels = tau.map((_, i) => distinguishingSegments(tau, i).join(' › '));
    expect(new Set(labels).size).toBe(2);
  });

  it('returns nothing when the paths are identical', () => {
    expect(
      distinguishingSegments(
        [
          ['A', 'B'],
          ['A', 'B'],
        ],
        0,
      ),
    ).toEqual([]);
  });

  it('returns nothing for a single result', () => {
    expect(distinguishingSegments([['A', 'B']], 0)).toEqual([]);
  });

  it('returns nothing for a document with no ancestors', () => {
    // The seven Scope documents sit at the root and have nothing to disambiguate against.
    expect(distinguishingSegments([[], ['A']], 0)).toEqual([]);
  });

  it('honours the maximum segment count', () => {
    expect(distinguishingSegments(paths, 0, 1)).toHaveLength(1);
  });
});
