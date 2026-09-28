/**
 * What gets embedded per document (SEARCH-18, the "embedded text" variable).
 *
 * The corpus's ~220-character bodies are the reason this is a variable at all: nine
 * documents named "Maximum Exposure" have near-identical bodies and are distinguishable
 * only by ancestry, so the hypothesis (H2.2) is that the retrieval document — carrying
 * breadcrumb, name, extras and (where generated) expansion — embeds far better than the
 * bare body.
 */
import type { FlatAtlasDocument } from '../../app/atlas/search/flatten-documents';

export const TEXT_VARIANTS = [
  'body',
  'name-body',
  'retrieval-doc',
  'retrieval-doc-no-expansion',
  'retrieval-doc-budgeted',
] as const;
export type TextVariant = (typeof TEXT_VARIANTS)[number];

export function buildEmbeddedText(doc: FlatAtlasDocument, variant: TextVariant): string {
  switch (variant) {
    case 'body':
      return doc.content || doc.name;
    case 'name-body':
      return [doc.name, doc.content].filter(Boolean).join('\n');
    case 'retrieval-doc-no-expansion':
      return [doc.breadcrumb.join(' › '), doc.name, doc.extras, doc.content].filter(Boolean).join('\n');
    case 'retrieval-doc':
      return [doc.breadcrumb.join(' › '), doc.name, doc.extras, doc.content, doc.expansion].filter(Boolean).join('\n');
    case 'retrieval-doc-budgeted':
      return [budgetedBreadcrumb(doc).join(' › '), doc.name, doc.extras, doc.content, doc.expansion]
        .filter(Boolean)
        .join('\n');
  }
}

/**
 * SEARCH-48 (zvec-grep I-3): metadata must not crowd out content — the breadcrumb may
 * use at most a third of everything else's length (≈ 25% of the whole). Root-side
 * segments drop first: deep documents share them, while the nearest ancestors carry the
 * distinguishing signal SEARCH-18 measured (nine "Maximum Exposure" documents differ
 * only by ancestry) — so the floor is the two nearest segments, kept whatever the ratio
 * says.
 */
export function budgetedBreadcrumb(doc: FlatAtlasDocument): string[] {
  const fixed = [doc.name, doc.extras, doc.content, doc.expansion].filter(Boolean).join('\n');
  let segments = doc.breadcrumb;
  while (segments.length > 2 && segments.join(' › ').length > fixed.length / 3) {
    segments = segments.slice(1);
  }
  return segments;
}
