import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildTreeContext } from '../tree-context';
import { createDoc } from './fixtures';

/**
 * A tree with the corpus's awkward shape included: a node *without* a doc_no sitting
 * between an indexed parent and indexed children (the 194 skip-level cases), so the
 * children's parent must resolve to the nearest indexed ancestor.
 */
function tree() {
  return [
    createDoc('Scope', 'A.1', 'Root Scope', 'Root content.', {
      articles: [
        createDoc('Article', 'A.1.1', 'First Article', 'First.', {
          sections_and_primary_docs: [
            createDoc('Section', 'A.1.1.1', 'First Section', 'Section body.'),
            createDoc('Section', 'A.1.1.2', 'Second Section', 'Section body.'),
          ],
        }),
        // The skip level: no doc_no, but indexed children underneath.
        createDoc('Annotation', '', 'Unnumbered Wrapper', 'Not indexed.', {
          sections_and_primary_docs: [createDoc('Section', 'A.1.0.3.1', 'Skip-Level Child', 'Deep body.')],
        }),
      ],
    }),
    createDoc('Scope', 'A.2', 'Second Scope', 'Another root.'),
  ];
}

describe('buildTreeContext', () => {
  const documents = flattenAtlasDocuments(tree());
  const context = buildTreeContext(documents);
  const idOf = (docNo: string) => documents.find((doc) => doc.doc_no === docNo)!.id;

  it('walks ancestors outermost-first and returns empty for roots', () => {
    expect(context.ancestorsOf(idOf('A.1.1.1')).map((doc) => doc.doc_no)).toEqual(['A.1', 'A.1.1']);
    expect(context.ancestorsOf(idOf('A.1'))).toEqual([]);
    expect(context.parentOf(idOf('A.2'))).toBeNull();
  });

  it('lists direct children in document order', () => {
    expect(context.childrenOf(idOf('A.1.1')).map((doc) => doc.doc_no)).toEqual(['A.1.1.1', 'A.1.1.2']);
    expect(context.childrenOf(idOf('A.1.1.1'))).toEqual([]);
  });

  it('resolves skip-level documents to their nearest indexed ancestor', () => {
    const skipChild = idOf('A.1.0.3.1');
    expect(context.parentOf(skipChild)?.doc_no).toBe('A.1'); // not the unnumbered wrapper
    expect(context.childrenOf(idOf('A.1')).map((doc) => doc.doc_no)).toContain('A.1.0.3.1');
    expect(context.ancestorsOf(skipChild).map((doc) => doc.doc_no)).toEqual(['A.1']);
  });
});
