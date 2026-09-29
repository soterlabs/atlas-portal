import type { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';

/**
 * Builds a tree document. `children` is spread onto the node under the given
 * child-collection key, matching the real export shape.
 */
export function createDoc(
  type: string,
  doc_no: string,
  name: string,
  content: string,
  children?: Partial<Record<string, ExportAtlasTreeDocument[]>>,
  extraFields?: Record<string, string>,
): ExportAtlasTreeDocument {
  return {
    type,
    doc_no,
    name,
    uuid: null,
    last_modified: '2026-01-01',
    content,
    ...children,
    ...extraFields,
  } as unknown as ExportAtlasTreeDocument;
}

/**
 * A small tree exercising every behavior the engine tests assert:
 * multi-word AND, typo tolerance, prefix matching, doc-number search,
 * name-vs-content ranking, depth ranking, type filtering, extra fields.
 */
export function createFixtureTree(): ExportAtlasTreeDocument[] {
  return [
    createDoc('Scope', 'A.1', 'Governance Scope', 'The governance process of the Atlas.', {
      articles: [
        createDoc(
          'Article',
          'A.1.6',
          'Aligned Delegates',
          'Delegates are compensated monthly. The budget for this is fixed.',
          {
            sections_and_primary_docs: [
              createDoc(
                'Section',
                'A.1.6.4',
                'AD Compensation Cycle',
                'Aligned Delegates receive compensation from their buffers.',
              ),
              createDoc('Section', 'A.1.6.5', 'Kickbacks Prohibited', 'See A.1.6.4 for the compensation rules.'),
            ],
          },
        ),
        createDoc('Article', 'A.1.7', 'Facilitators', 'Facilitator duties and requirements.'),
        // Accented text (SEARCH-02): must be found by both `Société` and `societe`.
        createDoc('Article', 'A.1.8', 'Société Générale Liaison', 'Liaison with the société on legal matters.'),
      ],
    }),
    createDoc('Scope', 'A.2', 'Support Scope', 'This scope defines the budget for support activities.', {
      sections_and_primary_docs: [
        createDoc('Type Specification', 'A.2.1', 'Budget Specification', 'Specification body text.', undefined, {
          type_specification_type_overview: 'Describes how treasury allocation is decided.',
        }),
      ],
    }),
    // Not indexed: no doc_no (spec §3).
    createDoc('Annotation', '', 'Orphan Annotation', 'This annotation has no document number.'),
  ];
}
