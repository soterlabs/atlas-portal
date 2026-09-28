import { describe, expect, it } from 'vitest';
import { classifyHit, originNote } from '../match-evidence';

const hit = (terms: string[], fields: string[] = ['content']) => ({ terms, fields });

describe('classifyHit (SEARCH-53)', () => {
  it('labels a literal word match exact', () => {
    expect(classifyHit(['compensation'], hit(['compensation'])).evidence).toBe('exact');
  });

  it('labels a stem meeting point as word forms', () => {
    // Query "compensated", document says "compensation": both stem to compens.
    expect(classifyHit(['compensated'], hit(['compensation'])).evidence).toBe('word-form');
  });

  it('labels a prefix expansion as prefix match (the axis → AxisLegate case)', () => {
    expect(classifyHit(['axis'], hit(['axislegate'])).evidence).toBe('prefix');
  });

  it('labels a fuzzy repair as typo-corrected (the maxium exposruee case)', () => {
    expect(classifyHit(['maxium'], hit(['maximum'])).evidence).toBe('typo');
    expect(classifyHit(['exposruee'], hit(['exposure'])).evidence).toBe('typo');
  });

  it('a hit is only as exact as its least exact word', () => {
    expect(classifyHit(['maximum', 'exposruee'], hit(['maximum', 'exposure'])).evidence).toBe('typo');
    expect(classifyHit(['maximum', 'exposure'], hit(['maximum', 'exposure'])).evidence).toBe('exact');
  });

  it('picks each word’s best evidence across the matched terms', () => {
    // "compensation" matches both its own term and the stem term: exact wins per word.
    expect(classifyHit(['compensation'], hit(['compens', 'compensation'])).evidence).toBe('exact');
  });

  it('flags expansion-only matches — the reader’s word is not in the document', () => {
    const result = classifyHit(['budget'], hit(['budget'], ['expansion']));
    expect(result).toEqual({ evidence: 'exact', expansionOnly: true });
    expect(classifyHit(['budget'], hit(['budget'], ['expansion', 'content'])).expansionOnly).toBe(false);
  });
});

describe('originNote (SEARCH-53, batch 4)', () => {
  it('is null when content or extras carry visible marks', () => {
    expect(originNote({ fields: ['content'] })).toBeNull();
    expect(originNote({ fields: ['name', 'extras'] })).toBeNull();
  });

  it('explains title-only, doc-number-only and expansion-only matches', () => {
    expect(originNote({ fields: ['name'] })).toBe('matches in the title');
    expect(originNote({ fields: ['doc_no'] })).toBe('matches the document number');
    expect(originNote({ fields: ['expansion'] })).toContain('generated phrasing');
  });

  it('stays out of the semantic tier’s way', () => {
    expect(originNote({ fields: [], provenance: 'rung' })).toBeNull();
    expect(originNote({ fields: ['name'], provenance: 'rung' })).toBeNull();
  });
});
