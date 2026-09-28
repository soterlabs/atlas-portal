import { describe, expect, it } from 'vitest';
import { buildSnippet, splitHighlight } from '../highlight';

describe('splitHighlight', () => {
  it('marks every occurrence of every term, as whole words', () => {
    // The engine reports stems, so matching is by word rather than substring: the plural
    // "delegates" is marked in full instead of only its "delegate" prefix.
    const segments = splitHighlight('Delegate compensation for delegates', ['delegate', 'compensation']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['Delegate', 'compensation', 'delegates']);
  });

  it('marks a word whose stem matches the reported term', () => {
    const segments = splitHighlight('Delegates are compensated monthly', ['deleg', 'compens']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['Delegates', 'compensated']);
  });

  it('preserves the original text when segments are rejoined', () => {
    const text = 'Delegate compensation for delegates';
    const segments = splitHighlight(text, ['delegate']);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('matches case-insensitively but keeps the original casing', () => {
    const segments = splitHighlight('GOVERNANCE', ['governance']);
    expect(segments).toEqual([{ text: 'GOVERNANCE', match: true }]);
  });

  it('prefers the longest term where two terms overlap', () => {
    const segments = splitHighlight('facilitators meet', ['facilitator', 'facilitators']);
    expect(segments[0]).toEqual({ text: 'facilitators', match: true });
  });

  it('escapes regex metacharacters in terms', () => {
    const segments = splitHighlight('see a.1.2 here', ['a.1.2']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['a.1.2']);
  });

  it('does not treat a dot as a wildcard', () => {
    const segments = splitHighlight('axbxc', ['a.b.c']);
    expect(segments).toEqual([{ text: 'axbxc', match: false }]);
  });

  it('matches accent-insensitively but keeps the original accents', () => {
    const segments = splitHighlight('The Société meets', ['societe']);
    expect(segments).toEqual([
      { text: 'The ', match: false },
      { text: 'Société', match: true },
      { text: ' meets', match: false },
    ]);
  });

  it('never splits a decomposed grapheme at the end of a match', () => {
    const text = 'Café au lait'; // "Café" with a combining acute accent
    const segments = splitHighlight(text, ['cafe']);
    expect(segments[0]).toEqual({ text: 'Café', match: true });
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('returns one unmatched segment when there are no terms', () => {
    expect(splitHighlight('plain text', [])).toEqual([{ text: 'plain text', match: false }]);
  });
});

describe('splitHighlight — the exactness vocabulary (SEARCH-77)', () => {
  it('marks a hyphenated pair whole, hyphen included, for the joined term', () => {
    const segments = splitHighlight('Assets move off-chain overnight', ['offchain']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['off-chain']);
  });

  it('rejoining reproduces the original around a pair mark', () => {
    const text = 'Assets move off-chain overnight';
    const segments = splitHighlight(text, ['offchain']);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('marks a space-separated pair whole — the same reading the exact test accepts', () => {
    const segments = splitHighlight('moved off chain yesterday', ['offchain']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['off chain']);
  });

  it('a raw hyphenated term marks the solid word', () => {
    const segments = splitHighlight('The offchain ledger', ['off-chain']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['offchain']);
  });

  it('never marks the pieces alone', () => {
    const segments = splitHighlight('the off switch and the chain', ['offchain']);
    expect(segments.every((s) => !s.match)).toBe(true);
  });

  it('word forms are tolerated across the join, as inside the exact test', () => {
    const segments = splitHighlight('several off-chains exist', ['offchain']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['off-chains']);
  });

  it('marks a three-part hyphenated compound whole for its joined term (bug 3)', () => {
    const segments = splitHighlight('the collateral-onboarding-checklist item', ['collateralonboardingchecklist']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['collateral-onboarding-checklist']);
  });

  it('a single-word match after a consumed pair is still marked', () => {
    const segments = splitHighlight('off-chain data moves offchain', ['offchain']);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['off-chain', 'offchain']);
  });
});

describe('buildSnippet', () => {
  it('centres on a triple-compound match instead of falling back to the head (bug 3)', () => {
    const text = `${'x '.repeat(200)}the collateral-onboarding-checklist item`;
    expect(buildSnippet(text, ['collateralonboardingchecklist'])).toContain('collateral-onboarding-checklist');
  });

  it('returns short text unchanged', () => {
    expect(buildSnippet('short content', ['content'], 150)).toBe('short content');
  });

  it('windows around the first matching term', () => {
    const text = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`;
    const snippet = buildSnippet(text, ['needle'], 60);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('falls back to the beginning when no term is present', () => {
    const text = 'x'.repeat(400);
    const snippet = buildSnippet(text, ['absent'], 50);
    expect(snippet.startsWith('x')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('windows around a hyphenated match found by its joined term (SEARCH-77)', () => {
    const text = `${'a'.repeat(300)} off-chain ${'b'.repeat(300)}`;
    expect(buildSnippet(text, ['offchain'], 60)).toContain('off-chain');
  });

  it('windows around an accented match found by its folded term', () => {
    const text = `${'a'.repeat(300)} Société ${'b'.repeat(300)}`;
    expect(buildSnippet(text, ['societe'], 60)).toContain('Société');
  });

  it('does not prefix an ellipsis when the match is at the start', () => {
    const text = `needle ${'b'.repeat(300)}`;
    expect(buildSnippet(text, ['needle'], 60).startsWith('needle')).toBe(true);
  });
});
