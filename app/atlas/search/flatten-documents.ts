import type { AtlasDocumentType } from '@/app/server/atlas/atlas-types';
import type { ChildCollectionName, ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { childCollectionNames, extraFieldsByDocumentType } from '@/app/server/atlas/export/types';

/** One indexable Atlas document, flattened out of the tree. */
export interface FlatAtlasDocument {
  /** Array position; used as the MiniSearch id, so it is unique even if doc_no is not. */
  id: number;
  doc_no: string;
  name: string;
  type: AtlasDocumentType;
  /** Content with markdown link syntax reduced to its text. */
  content: string;
  /** The type's extra fields, newline-joined. Empty for types without any. */
  extras: string;
  /**
   * Generated search-expansion text (SEARCH-17): paraphrase + questions in the reader's
   * vocabulary. Only the build-time index carries it — the in-browser fallback build
   * passes no expansions and the field is empty, which merely loses the expansion boost.
   */
  expansion: string;
  /**
   * SEARCH-56 measured arm: distinctive ancestor-title keywords, space-joined,
   * indexed in the low-boost `inherited` field. Absent on the shipped path — only
   * the arm harness attaches it.
   */
  inherited?: string;
  /** Ancestor names, outermost first. */
  breadcrumb: string[];
  /** 0 for scope roots, +1 per level. */
  depth: number;
  /**
   * The id of the nearest ancestor that carries a `doc_no`, or null for roots
   * (SEARCH-31). Carried from the actual traverse rather than derived from doc-number
   * prefixes: 194 corpus documents use skip-level numbering, so prefixes lie about
   * parentage while the tree cannot.
   */
  parentId: number | null;
  /** The original node, for rendering fields the index does not store. */
  source: ExportAtlasTreeDocument;
}

/** Converts `[text](url)` to `text`. Applied before indexing and before snippeting. */
export function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function hasChildCollection(
  doc: ExportAtlasTreeDocument,
  collectionName: ChildCollectionName,
): doc is ExportAtlasTreeDocument & Record<ChildCollectionName, ExportAtlasTreeDocument[]> {
  return collectionName in doc && Array.isArray((doc as unknown as Record<string, unknown>)[collectionName]);
}

function collectExtras(doc: ExportAtlasTreeDocument): string {
  const fieldKeys = extraFieldsByDocumentType[doc.type];
  if (!fieldKeys || fieldKeys.length === 0) return '';

  const record = doc as unknown as Record<string, unknown>;
  return fieldKeys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

/**
 * Flattens the scope trees depth-first into indexable records.
 *
 * Documents without a `doc_no` are skipped (they cannot be navigated to) but are
 * still traversed, so their descendants are not lost.
 */
export function flattenAtlasDocuments(
  scopeTrees: ExportAtlasTreeDocument[],
  /** Generated expansion text keyed by document UUID (or `doc_no` without one), SEARCH-17. */
  expansions?: Record<string, string>,
): FlatAtlasDocument[] {
  const result: FlatAtlasDocument[] = [];

  function traverse(doc: ExportAtlasTreeDocument, breadcrumb: string[], depth: number, parentId: number | null): void {
    let ownId = parentId;
    if (doc.doc_no) {
      ownId = result.length;
      result.push({
        id: ownId,
        doc_no: doc.doc_no,
        name: doc.name ?? '',
        type: doc.type,
        content: stripMarkdownLinks(doc.content ?? ''),
        extras: collectExtras(doc),
        expansion: expansions?.[doc.uuid ?? doc.doc_no] ?? '',
        breadcrumb,
        depth,
        parentId,
        source: doc,
      });
    }

    // A node without a doc_no is skipped but traversed — its children's parent is the
    // nearest indexed ancestor, exactly what the peek should show.
    const childBreadcrumb = [...breadcrumb, doc.name || '<Untitled>'];
    for (const collectionName of childCollectionNames) {
      if (hasChildCollection(doc, collectionName)) {
        for (const child of doc[collectionName]) {
          traverse(child, childBreadcrumb, depth + 1, ownId);
        }
      }
    }
  }

  for (const tree of scopeTrees) traverse(tree, [], 0, null);
  return result;
}
