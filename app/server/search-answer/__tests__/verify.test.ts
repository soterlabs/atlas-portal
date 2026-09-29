import { describe, expect, it } from 'vitest';
import { allFaithful, normalizeForQuote, qualifierRetained, quoteIsVerbatim, verifyClaims } from '../verify';

const DOC =
  'Where the Atlas specifies a maximum exposure, actual exposure may exceed that maximum by up to 5%, ' +
  'provided the excess is solely attributable to accrued interest and not to new principal.';

describe('quoteIsVerbatim', () => {
  it('accepts a verbatim passage regardless of whitespace reflow and curly quotes', () => {
    expect(quoteIsVerbatim('may exceed that maximum by up to 5%,\n  provided the excess', DOC)).toBe(true);
    expect(normalizeForQuote('“solely”')).toBe('"solely"');
  });

  it('rejects paraphrase, elision, changed numbers, and stitched passages', () => {
    expect(quoteIsVerbatim('exposure can exceed the maximum by 5%', DOC)).toBe(false); // paraphrase
    expect(quoteIsVerbatim('may exceed that maximum … accrued interest', DOC)).toBe(false); // elision
    expect(quoteIsVerbatim('may exceed that maximum by up to 6%', DOC)).toBe(false); // changed number
    expect(quoteIsVerbatim('new principal. Where the Atlas specifies', DOC)).toBe(false); // wrap-around stitch
  });

  it('rejects quotes too short to support anything', () => {
    expect(quoteIsVerbatim('up to 5%', DOC)).toBe(false);
  });
});

describe('qualifierRetained', () => {
  it('finds the qualifier in claim text or in a quote', () => {
    expect(
      qualifierRetained(
        'solely attributable to accrued interest',
        [],
        ['provided the excess is solely attributable to accrued interest'],
      ),
    ).toBe(true);
    expect(qualifierRetained('up to 5%', ['Exposure may exceed the maximum by up to 5%.'], [])).toBe(true);
    expect(qualifierRetained('up to 5%', ['Exposure may exceed the maximum.'], ['some other quote entirely'])).toBe(
      false,
    );
  });
});

describe('verifyClaims / allFaithful', () => {
  const context = new Map([['A.1', DOC]]);

  it('verifies a good claim and fails unknown documents and bad quotes', () => {
    const results = verifyClaims(
      [
        { text: 'ok', quote: 'provided the excess is solely attributable to accrued interest', docNo: 'A.1' },
        { text: 'unknown doc', quote: 'provided the excess is solely attributable', docNo: 'A.9' },
        { text: 'bad quote', quote: 'this sentence appears nowhere in the document', docNo: 'A.1' },
      ],
      context,
    );
    expect(results[0]).toMatchObject({ documentKnown: true, quoteVerbatim: true });
    expect(results[1]).toMatchObject({ documentKnown: false });
    expect(results[2]).toMatchObject({ documentKnown: true, quoteVerbatim: false });
    expect(allFaithful(results)).toBe(false);
    expect(allFaithful([results[0]])).toBe(true);
  });

  it('an empty claim list is never faithful', () => {
    expect(allFaithful([])).toBe(false);
  });
});
