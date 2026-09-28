import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments, stripMarkdownLinks } from '../flatten-documents';
import { createFixtureTree } from './fixtures';

describe('flattenAtlasDocuments', () => {
  it('flattens the whole tree depth-first', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    expect(docs.map((d) => d.doc_no)).toEqual(['A.1', 'A.1.6', 'A.1.6.4', 'A.1.6.5', 'A.1.7', 'A.1.8', 'A.2', 'A.2.1']);
  });

  it('excludes documents without a doc_no but still traverses them', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    expect(docs.find((d) => d.name === 'Orphan Annotation')).toBeUndefined();
  });

  it('assigns sequential ids matching array position', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    docs.forEach((doc, index) => expect(doc.id).toBe(index));
  });

  it('records ancestor names as breadcrumb', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const section = docs.find((d) => d.doc_no === 'A.1.6.4')!;
    expect(section.breadcrumb).toEqual(['Governance Scope', 'Aligned Delegates']);
  });

  it('records tree depth starting at 0 for scopes', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    expect(docs.find((d) => d.doc_no === 'A.1')!.depth).toBe(0);
    expect(docs.find((d) => d.doc_no === 'A.1.6')!.depth).toBe(1);
    expect(docs.find((d) => d.doc_no === 'A.1.6.4')!.depth).toBe(2);
  });

  it('concatenates the type extra fields into extras', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const spec = docs.find((d) => d.doc_no === 'A.2.1')!;
    expect(spec.extras).toContain('treasury allocation');
  });

  it('leaves extras empty for types without extra fields', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    expect(docs.find((d) => d.doc_no === 'A.1')!.extras).toBe('');
  });

  it('keeps a reference to the source document', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    expect(docs[0].source.name).toBe('Governance Scope');
  });
});

describe('stripMarkdownLinks', () => {
  it('replaces link syntax with its text', () => {
    expect(stripMarkdownLinks('see [the rules](https://x.dev/a) now')).toBe('see the rules now');
  });

  it('leaves plain text untouched', () => {
    expect(stripMarkdownLinks('no links here')).toBe('no links here');
  });
});
