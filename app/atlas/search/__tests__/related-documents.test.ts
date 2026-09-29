import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import { RELATED_CAP, describeReason, relatedDocuments } from '../related-documents';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Rules', 'Rules text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'CRR Definition', 'Definition.'),
      createDoc('Article', 'A.1.2', 'Grove CRR', 'Grove capital.'),
      createDoc('Article', 'A.1.3', 'Cash Rules', 'Cash.'),
      createDoc('Article', 'A.1.4', 'Citing Doc', 'Cites the definition.'),
      createDoc('Article', 'A.1.5', 'Generic Only', 'Generic.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.1.2' }, { id: 'A.1.3' }, { id: 'A.1.4' }, { id: 'A.1.5' }],
  entities: [
    { id: 'crr', name: 'CRR', aliases: [], tier: 'concept', stands_for: 'Capital Ratio Requirement', mention_count: 6 },
    { id: 'grove', name: 'Grove', aliases: [], tier: 'instance', stands_for: null, mention_count: 4 },
    { id: 'instance', name: 'Instance', aliases: [], tier: 'concept', stands_for: null, mention_count: 5000 },
    {
      id: 'cash_stablecoins',
      name: 'Cash Stablecoins',
      aliases: [],
      tier: 'concept',
      stands_for: null,
      mention_count: 2,
    },
  ],
  mentions: [
    { entity: 'crr', section_id: 'A.1.1', count: 4 },
    { entity: 'crr', section_id: 'A.1.2', count: 2 },
    { entity: 'grove', section_id: 'A.1.1', count: 1 },
    { entity: 'grove', section_id: 'A.1.2', count: 3 },
    { entity: 'instance', section_id: 'A.1.1', count: 9 },
    { entity: 'instance', section_id: 'A.1.5', count: 9 },
    { entity: 'cash_stablecoins', section_id: 'A.1.3', count: 2 },
  ],
  edges: [
    { s: 'A.1.4', r: 'references', o: 'A.1.1', kind: 'section-section' },
    { s: 'crr', r: 'applies_to', o: 'cash_stablecoins', kind: 'entity-entity', section_ids: ['A.1.3'] },
    {
      s: 'crr',
      r: 'requirement',
      o: 'A.1.5',
      kind: 'entity-section',
      canonical: 'has_requirement',
      basis: 'structural',
      section_ids: ['A.1.5'],
    },
    // grove is crr's recorded opposite; both poles co-occur in A.1.2.
    {
      s: 'crr',
      r: 'opposite_of',
      o: 'grove',
      kind: 'entity-entity',
      opposition_kind: 'failure',
      section_ids: ['A.1.2'],
    },
  ],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'test-hash').artifact);

describe('relatedDocuments (SEARCH-63)', () => {
  it('orders reasons by strength: citations, opposites, typed evidence, shared entities', () => {
    const related = relatedDocuments('A.1.1', graph);
    expect(related.map((entry) => [entry.docNo, entry.reason.kind])).toEqual([
      ['A.1.4', 'cited-by'], // A.1.4 cites A.1.1
      ['A.1.2', 'opposite'], // crr ↔ grove co-occurrence section (SEARCH-64)
      ['A.1.5', 'aspect'], // crr — requirement, the section stating it (SEARCH-65)
      ['A.1.3', 'typed-edge'], // crr applies_to cash_stablecoins, evidenced there
    ]);
    expect(related[1].reason).toEqual({
      kind: 'opposite',
      docEntity: 'crr',
      opposite: 'grove',
      oppositionKind: 'failure',
    });
  });

  it('a document related only through a hyper-generic entity never appears', () => {
    // A.1.5 now appears as crr's aspect section — but never as a shared-entity
    // entry through 'instance' (5,000 corpus mentions): the reason must be the
    // aspect, not the generic co-mention.
    const related = relatedDocuments('A.1.1', graph);
    const entry = related.find((candidate) => candidate.docNo === 'A.1.5');
    expect(entry?.reason.kind).toBe('aspect');
  });

  it('excludes the document itself and honours the corpus filter', () => {
    const related = relatedDocuments('A.1.1', graph, (docNo) => docNo !== 'A.1.4');
    expect(related.some((entry) => entry.docNo === 'A.1.1')).toBe(false);
    expect(related.some((entry) => entry.docNo === 'A.1.4')).toBe(false);
  });

  it('citations read from both directions', () => {
    const fromCiting = relatedDocuments('A.1.4', graph);
    expect(fromCiting[0]).toMatchObject({ docNo: 'A.1.1', reason: { kind: 'cites' } });
  });

  it('caps the list and stays deterministic', () => {
    const first = relatedDocuments('A.1.1', graph);
    expect(first.length).toBeLessThanOrEqual(RELATED_CAP);
    expect(relatedDocuments('A.1.1', graph)).toEqual(first);
  });

  it('returns [] for a document the graph knows nothing about', () => {
    expect(relatedDocuments('A.9.9', graph)).toEqual([]);
  });
});

describe('describeReason (SEARCH-63)', () => {
  it('renders human-readable reasons, using stands_for where recorded', () => {
    expect(describeReason({ kind: 'cited-by' }, graph)).toBe('cites this document');
    expect(
      describeReason({ kind: 'typed-edge', subject: 'crr', relation: 'applies_to', object: 'cash_stablecoins' }, graph),
    ).toBe('Capital Ratio Requirement applies to Cash Stablecoins');
    expect(describeReason({ kind: 'shared-entities', entities: ['crr', 'grove'] }, graph)).toBe(
      'shares: Capital Ratio Requirement, Grove',
    );
    expect(
      describeReason({ kind: 'opposite', docEntity: 'crr', opposite: 'grove', oppositionKind: 'failure' }, graph),
    ).toBe('about Grove, the failure mode of Capital Ratio Requirement');
    expect(describeReason({ kind: 'aspect', entity: 'crr', wording: 'voting responsibility' }, graph)).toBe(
      'Capital Ratio Requirement — voting responsibility',
    );
  });
});
