import { describe, expect, it } from 'vitest';
import { scopeChips } from '../scope-chips';

describe('scopeChips', () => {
  const paths = [
    ['Agent Scope', 'Artifacts', 'Spark'],
    ['Agent Scope', 'Artifacts', 'Spark'],
    ['Agent Scope', 'Artifacts', 'Grove'],
    ['Agent Scope', 'Artifacts', 'Grove'],
    ['Agent Scope', 'Artifacts', 'Morpho'],
    ['Agent Scope', 'Artifacts', 'Aave'],
  ];

  it('never offers an ancestor shared by every result', () => {
    // Filtering by it would change nothing, which is why frequency is the wrong ranking:
    // the most common ancestors of a real query sit in 100 of 100 results.
    expect(scopeChips(paths)).not.toContain('Agent Scope');
    expect(scopeChips(paths)).not.toContain('Artifacts');
  });

  it('never offers an ancestor held by a single result', () => {
    expect(scopeChips(paths)).not.toContain('Morpho');
    expect(scopeChips(paths)).not.toContain('Aave');
  });

  it('offers the ancestors that actually split the result set', () => {
    expect(scopeChips(paths)).toEqual(expect.arrayContaining(['Spark', 'Grove']));
  });

  it('orders by closeness to an even split', () => {
    const uneven = [
      ['Root', 'Big'],
      ['Root', 'Big'],
      ['Root', 'Big'],
      ['Root', 'Big'],
      ['Root', 'Half'],
      ['Root', 'Half'],
      ['Root', 'Other'],
      ['Root', 'Other'],
    ];
    // 8 results: "Big" holds 4, an even split; "Half" and "Other" hold 2 each.
    expect(scopeChips(uneven)[0]).toBe('Big');
  });

  it('counts a repeated ancestor within one path once', () => {
    // Two of four rows pass through "Loop" twice; it still covers only those two rows.
    const looped = [
      ['Root', 'Loop', 'Loop', 'X'],
      ['Root', 'Loop', 'Loop', 'Y'],
      ['Root', 'Other', 'X'],
      ['Root', 'Other', 'Y'],
    ];
    expect(scopeChips(looped)).toEqual(expect.arrayContaining(['Loop', 'Other']));
  });

  it('caps the number of chips', () => {
    expect(scopeChips(paths, 1)).toHaveLength(1);
  });

  it('returns nothing when there is nothing to split', () => {
    expect(scopeChips([['A'], ['A']])).toEqual([]);
    expect(scopeChips([])).toEqual([]);
  });
});
