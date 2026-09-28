import { describe, expect, it } from 'vitest';
import { parseQuerySyntax } from '../query-syntax';

describe('parseQuerySyntax (SEARCH-34)', () => {
  it('passes plain queries through untouched', () => {
    expect(parseQuerySyntax('maximum cap')).toEqual({
      terms: 'maximum cap',
      types: [],
      scopes: [],
      titleOnly: false,
      phrases: [],
      exactPhrases: [],
      excludes: [],
      operators: [],
    });
  });

  it('leaves apostrophes inside words alone; only a quote at a word boundary opens an exact phrase (bug 5)', () => {
    const natural = parseQuerySyntax("what's the facilitator's role");
    expect(natural.exactPhrases).toEqual([]);
    expect(natural.operators).toEqual([]);
    expect(natural.terms).toBe("what's the facilitator's role");

    const punctuated = parseQuerySyntax("what is 'delegatedSigners'?");
    expect(punctuated.exactPhrases).toEqual(['delegatedSigners']);
    expect(punctuated.terms).toBe('what is ? delegatedSigners');
    expect(parseQuerySyntax("find 'Foo', please").exactPhrases).toEqual(['Foo']);

    const mixed = parseQuerySyntax("what's 'delegatedSigners' role");
    expect(mixed.exactPhrases).toEqual(['delegatedSigners']);
    expect(mixed.operators.map((operator) => operator.raw)).toEqual(["'delegatedSigners'"]);
    expect(mixed.terms).toBe("what's role delegatedSigners");
  });

  it('never treats an all-digit query as a UUID jump (bug 6)', () => {
    expect(parseQuerySyntax('10000000').uuidJump).toBeUndefined();
    expect(parseQuerySyntax('10000000').terms).toBe('10000000');
    expect(parseQuerySyntax('2025-11-13').uuidJump).toBeUndefined();
    expect(parseQuerySyntax('a491d7d0').uuidJump).toBe('a491d7d0');
    expect(parseQuerySyntax('1234567a').uuidJump).toBe('1234567a');
  });

  it('parses phrases, exact phrases and exclusions (SEARCH-35)', () => {
    const parsed = parseQuerySyntax('"properly implemented" budget -slippery');
    expect(parsed.phrases).toEqual(['properly implemented']);
    expect(parsed.excludes).toEqual(['slippery']);
    expect(parsed.terms).toBe('budget properly implemented'); // phrase words stay retrievable
    expect(parsed.operators.map((operator) => operator.raw)).toEqual(['"properly implemented"', '-slippery']);

    const exact = parseQuerySyntax("'delegatedSigners' registry");
    expect(exact.exactPhrases).toEqual(['delegatedSigners']);
    expect(exact.terms).toBe('registry delegatedSigners');

    // Unclosed quotes and lone dashes stay literal.
    expect(parseQuerySyntax('"unclosed budget').phrases).toEqual([]);
    expect(parseQuerySyntax('a - b').excludes).toEqual([]);
    // A quoted type: value is an operator, not a phrase.
    expect(parseQuerySyntax('type:"Scenario Variation"').phrases).toEqual([]);
  });

  it('reports each operator with the exact text it consumed, for removable pills', () => {
    const parsed = parseQuerySyntax('type:"Scenario Variation" in:A.1 quorum');
    expect(parsed.operators).toEqual([
      { key: 'type', value: 'Scenario Variation', raw: 'type:"Scenario Variation"' },
      { key: 'in', value: 'A.1', raw: 'in:A.1' },
    ]);
  });

  it('parses type filters — plain, underscored, and quoted', () => {
    expect(parseQuerySyntax('type:Annotation budget').types).toEqual(['Annotation']);
    expect(parseQuerySyntax('type:Scenario_Variation').types).toEqual(['Scenario Variation']);
    const quoted = parseQuerySyntax('type:"Scenario Variation" budget');
    expect(quoted.types).toEqual(['Scenario Variation']);
    expect(quoted.terms).toBe('budget');
  });

  it('parses subtree and title operators', () => {
    const parsed = parseQuerySyntax('in:A.1.2 title:facilitator removal');
    expect(parsed.scopes).toEqual(['A.1.2']);
    expect(parsed.titleOnly).toBe(true);
    expect(parsed.terms).toBe('removal facilitator'); // title value is still a search term
  });

  it('accumulates repeated operators and mixes with free text', () => {
    const parsed = parseQuerySyntax('type:Core type:Annotation in:A.1 quorum');
    expect(parsed.types).toEqual(['Core', 'Annotation']);
    expect(parsed.scopes).toEqual(['A.1']);
    expect(parsed.terms).toBe('quorum');
  });

  it('leaves malformed or unknown operators as literal text — never an error', () => {
    expect(parseQuerySyntax('type: budget').terms).toBe('type: budget'); // bare key
    expect(parseQuerySyntax('type:"Scenario budget').terms).toBe('type:"Scenario budget'); // unclosed quote
    expect(parseQuerySyntax('field:title govern').terms).toBe('field:title govern'); // unknown key
    expect(parseQuerySyntax('ty budget').terms).toBe('ty budget'); // half-typed key
  });

  it('treats a whole-query UUID or ≥8-hex prefix as a jump, not a search', () => {
    expect(parseQuerySyntax('a491d7d0-e461-4e8e-aa1b-1234567890ab').uuidJump).toBe('a491d7d0e4614e8eaa1b1234567890ab');
    expect(parseQuerySyntax('A491D7D0').uuidJump).toBe('a491d7d0');
    expect(parseQuerySyntax('a491d7d').uuidJump).toBeUndefined(); // 7 hex: an ordinary search
    expect(parseQuerySyntax('a491d7d0 budget').uuidJump).toBeUndefined(); // not the whole query
    expect(parseQuerySyntax('deadbeef1').uuidJump).toBe('deadbeef1');
  });
});
