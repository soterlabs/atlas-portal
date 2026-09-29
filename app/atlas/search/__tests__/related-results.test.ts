import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import { RELATED_STRENGTH_FLOOR, relatedResults } from '../related-results';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Delegates', 'Delegates scope.', {
    articles: [
      createDoc('Article', 'A.1.1', 'AD Responsibility', 'The duties list.'),
      createDoc('Article', 'A.1.2', 'AD Mentions', 'Where the delegate is discussed.'),
      createDoc('Article', 'A.1.3', 'Citing Doc', 'Cites the responsibility section.'),
      createDoc('Article', 'A.1.4', 'Debt Rules', 'The debt rules.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);
const docNameOf = (docNo: string) => documents.find((document) => document.doc_no === docNo)?.name ?? null;

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.1.2' }, { id: 'A.1.3' }, { id: 'A.1.4' }],
  entities: [
    { id: 'ad', name: 'Aligned Delegate', aliases: ['AD'], tier: 'concept', stands_for: null, mention_count: 20 },
    { id: 'debt', name: 'Debt', aliases: [], tier: 'concept', stands_for: null, mention_count: 4 },
  ],
  mentions: [
    { entity: 'ad', section_id: 'A.1.2', count: 5 },
    { entity: 'ad', section_id: 'A.1.1', count: 2 },
    { entity: 'debt', section_id: 'A.1.4', count: 3 },
  ],
  edges: [
    { s: 'A.1.3', r: 'references', o: 'A.1.2', kind: 'section-section' },
    {
      s: 'ad',
      r: 'responsibility',
      o: 'A.1.1',
      kind: 'entity-section',
      canonical: 'has_duty',
      basis: 'structural',
      section_ids: ['A.1.1'],
    },
    { s: 'ad', r: 'opposite_of', o: 'debt', kind: 'entity-entity', opposition_kind: 'antonym', section_ids: [] },
  ],
  relations: [{ name: 'has_duty', members: ['responsibility', 'duty'], oppositional: false }],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'hash').artifact);

describe('relatedResults (SEARCH-71)', () => {
  it('a full-chain query yields answer rows at strength 1, ahead of everything', () => {
    const rows = relatedResults('aligned delegate duties', graph, { docNameOf });
    expect(rows[0]).toEqual({
      docNo: 'A.1.1',
      kind: 'answer',
      reason: 'The related terms “Aligned Delegate” and “responsibility” are connected in this section.',
      strength: 1,
    });
  });

  it('kind precedence orders citation over mention for the same coverage', () => {
    const rows = relatedResults('aligned delegate', graph, { docNameOf });
    const kinds = rows.map((row) => row.kind);
    expect(kinds.indexOf('citation')).toBeLessThan(kinds.indexOf('mention'));
    // The citing doc's reason names what it cites, in words.
    expect(rows.find((row) => row.kind === 'citation')).toMatchObject({
      docNo: 'A.1.3',
      reason: 'This section cites “AD Mentions”.',
    });
  });

  it('strength is the query-word share the connection consumed', () => {
    // 'aligned delegate' covers 2 of 3 words of 'aligned delegate history'.
    const rows = relatedResults('aligned delegate history', graph, { docNameOf });
    const mention = rows.find((row) => row.kind === 'mention');
    expect(mention?.strength).toBeCloseTo(2 / 3);
    expect((mention?.strength ?? 0) >= RELATED_STRENGTH_FLOOR).toBe(true);
    // A one-of-two coverage sits below the floor.
    const half = relatedResults('debt process', graph, { docNameOf });
    expect(half.every((row) => row.strength < RELATED_STRENGTH_FLOOR)).toBe(true);
  });

  it('excludes what the list already shows, dedupes by strongest kind, silent without entities', () => {
    const rows = relatedResults('aligned delegate duties', graph, { docNameOf, exclude: new Set(['A.1.1']) });
    expect(rows.some((row) => row.docNo === 'A.1.1')).toBe(false);
    const all = relatedResults('aligned delegate duties', graph, { docNameOf });
    // A.1.1 is answer AND mention AND fact — one row, the strongest kind.
    expect(all.filter((row) => row.docNo === 'A.1.1')).toHaveLength(1);
    expect(relatedResults('nothing resolves here', graph, { docNameOf })).toEqual([]);
  });

  it('opposites carry the stated relationship', () => {
    const rows = relatedResults('aligned delegate', graph, { docNameOf });
    expect(rows.find((row) => row.kind === 'opposite')).toMatchObject({
      docNo: 'A.1.4',
      reason: 'This section is about “Debt” — the opposite of “Aligned Delegate”.',
    });
  });
});
