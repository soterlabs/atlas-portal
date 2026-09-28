/**
 * Tree accessors over the flat document list (SEARCH-31): where a document sits in the
 * Atlas, its ancestors, and its direct children — the substrate for the result-context
 * peek and for SEARCH-32's induced-result-tree segments.
 *
 * Built from `FlatAtlasDocument.parentId`, which the flattening traverse carries from
 * the actual tree. Documents whose structural parent lacks a `doc_no` point at the
 * nearest indexed ancestor — the corpus contains 194 such skip-level cases, which is
 * why parentage is never derived from doc-number prefixes.
 *
 * Pure and cheap: one pass to index children, O(depth) per ancestor chain.
 */
import type { FlatAtlasDocument } from './flatten-documents';

export interface TreeContext {
  /** Ancestors of the document, outermost first; empty for roots. */
  ancestorsOf: (id: number) => FlatAtlasDocument[];
  /** Direct children (nearest indexed descendants), in document order. */
  childrenOf: (id: number) => FlatAtlasDocument[];
  /** The document's parent, or null for roots. */
  parentOf: (id: number) => FlatAtlasDocument | null;
}

export function buildTreeContext(documents: FlatAtlasDocument[]): TreeContext {
  const childIds = new Map<number, number[]>();
  for (const document of documents) {
    if (document.parentId === null) continue;
    const siblings = childIds.get(document.parentId);
    if (siblings) siblings.push(document.id);
    else childIds.set(document.parentId, [document.id]);
  }

  const parentOf = (id: number): FlatAtlasDocument | null => {
    const parentId = documents[id]?.parentId ?? null;
    return parentId === null ? null : (documents[parentId] ?? null);
  };

  return {
    parentOf,
    ancestorsOf: (id) => {
      const chain: FlatAtlasDocument[] = [];
      // Defensive bound: a corrupt parentId cycle must never hang the UI.
      for (let current = parentOf(id); current && chain.length <= documents.length; current = parentOf(current.id)) {
        chain.push(current);
      }
      return chain.reverse();
    },
    childrenOf: (id) => (childIds.get(id) ?? []).map((childId) => documents[childId]),
  };
}
