import { describe, expect, it } from 'vitest';
import { fragmentDocument } from '../fragments';

const options = { chunkChars: 60, overlapChars: 12 };

describe('fragmentDocument (SEARCH-40)', () => {
  it('returns no fragments for empty or whitespace-only text', () => {
    expect(fragmentDocument('', options)).toEqual([]);
    expect(fragmentDocument('  \n\n \n', options)).toEqual([]);
  });

  it('keeps a short document as a single fragment with its heading', () => {
    const fragments = fragmentDocument('## Scope\n\nOne short paragraph.', options);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ index: 0, heading: 'Scope' });
    expect(fragments[0].text).toContain('One short paragraph.');
  });

  it('splits at paragraph boundaries and preserves every paragraph somewhere', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i} with some words.`);
    const fragments = fragmentDocument(paragraphs.join('\n\n'), options);
    expect(fragments.length).toBeGreaterThan(1);
    const all = fragments.map((f) => f.text).join('\n');
    for (const paragraph of paragraphs) expect(all).toContain(paragraph);
    expect(fragments.map((f) => f.index)).toEqual(fragments.map((_, i) => i));
  });

  it('carries overlap from the previous fragment', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Block ${i} padded to a useful length here.`);
    const fragments = fragmentDocument(paragraphs.join('\n\n'), options);
    expect(fragments.length).toBeGreaterThan(1);
    // The second fragment begins with the tail of the first's content.
    const firstTail = fragments[0].text.slice(-options.overlapChars);
    expect(fragments[1].text.startsWith(firstTail)).toBe(true);
  });

  it('hard-splits a single oversized paragraph without loss', () => {
    const long = 'x'.repeat(200);
    const fragments = fragmentDocument(long, options);
    expect(fragments.length).toBeGreaterThan(2);
    const covered = new Set(fragments.flatMap((f) => f.text.split('')));
    expect(covered.has('x')).toBe(true);
    const totalX = fragments.reduce((n, f) => n + f.text.length, 0);
    expect(totalX).toBeGreaterThanOrEqual(200); // overlap duplicates, never drops
  });

  it('scopes fragments to the most recent heading', () => {
    const text = ['# Alpha', 'First body paragraph.', '# Beta', 'Second body paragraph.'].join('\n\n');
    const fragments = fragmentDocument(text, { chunkChars: 30, overlapChars: 5 });
    const headings = fragments.map((f) => f.heading);
    expect(headings[0]).toBe('Alpha');
    expect(headings[headings.length - 1]).toBe('Beta');
  });

  it('rejects invalid options', () => {
    expect(() => fragmentDocument('text', { chunkChars: 0, overlapChars: 0 })).toThrow();
    expect(() => fragmentDocument('text', { chunkChars: 10, overlapChars: 10 })).toThrow();
  });
});
