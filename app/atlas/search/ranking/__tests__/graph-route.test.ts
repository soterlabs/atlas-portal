import { describe, expect, it } from 'vitest';
import { createDoc } from '../../__tests__/fixtures';
import { flattenAtlasDocuments } from '../../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../../graph-artifact';
import type { AtlasSearchHit } from '../../search-index';
import { graphCandidates, graphSignal, rerankWithinTiers, resolveQueryEntities } from '../graph-route';

const tree = [
  createDoc('Scope', 'A.1', 'Rules', 'Rules text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'CRR Definition', 'Definition text.'),
      createDoc('Article', 'A.1.2', 'Grove CRR', 'Grove capital text.'),
      createDoc('Article', 'A.1.3', 'Grove Notes', 'Notes text.'),
      createDoc('Article', 'A.1.4', 'Admin CRR', 'Admin text.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.1.2' }, { id: 'A.1.3' }, { id: 'A.1.4' }],
  entities: [
    {
      id: 'crr',
      name: 'CRR',
      aliases: ['Capital Ratio Requirement'],
      tier: 'concept',
      stands_for: 'Capital Ratio Requirement',
      mention_count: 10,
    },
    { id: 'grove', name: 'Grove', aliases: [], tier: 'instance', stands_for: null, mention_count: 8 },
    // A hyper-generic entity: its mentions must carry much less weight.
    { id: 'instance', name: 'Instance', aliases: [], tier: 'concept', stands_for: null, mention_count: 5000 },
    { id: 'admin_crr', name: 'Administrative CRR', aliases: [], tier: 'concept', stands_for: null, mention_count: 2 },
  ],
  mentions: [
    { entity: 'crr', section_id: 'A.1.1', count: 5 },
    { entity: 'crr', section_id: 'A.1.2', count: 1 },
    { entity: 'grove', section_id: 'A.1.2', count: 2 },
    { entity: 'grove', section_id: 'A.1.3', count: 4 },
    { entity: 'instance', section_id: 'A.1', count: 9 },
    { entity: 'admin_crr', section_id: 'A.1.4', count: 3 },
  ],
  edges: [{ s: 'admin_crr', r: 'is_a_type_of', o: 'crr', kind: 'entity-entity', section_ids: ['A.1.4'] }],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'test-hash').artifact);

describe('resolveQueryEntities (SEARCH-60)', () => {
  it('greedy longest-phrase matching consumes multi-word aliases whole', () => {
    const resolved = resolveQueryEntities('capital ratio requirement grove', graph);
    expect(resolved.map((entity) => entity.id)).toEqual(['crr', 'grove']);
    expect(resolved[0].surface).toBe('capital ratio requirement');
  });

  it('folds case and accents, and returns [] for unresolvable text', () => {
    expect(resolveQueryEntities('CRR', graph).map((entity) => entity.id)).toEqual(['crr']);
    expect(resolveQueryEntities('nothing matches here', graph)).toEqual([]);
  });
});

describe('graphCandidates (SEARCH-60 Arm A)', () => {
  it('ranks coverage first: the document mentioning both entities wins', () => {
    const candidates = graphCandidates('crr grove', graph);
    expect(candidates[0].docNo).toBe('A.1.2');
    expect(candidates[0].coverage).toBe(2);
    // The rest mention exactly one entity each.
    expect(candidates.slice(1).every((candidate) => candidate.coverage === 1)).toBe(true);
  });

  it('weights generic entities down: a rare entity outranks a hyper-generic one', () => {
    // 'crr' (10 corpus mentions, count 5 in A.1.1) must beat 'instance'
    // (5,000 corpus mentions, count 9 in A.1).
    const candidates = graphCandidates('crr instance', graph);
    const first = candidates.find((candidate) => candidate.docNo === 'A.1.1')!;
    const generic = candidates.find((candidate) => candidate.docNo === 'A.1')!;
    expect(first.score).toBeGreaterThan(generic.score);
  });

  it('one-hop expansion pulls in subtype mentions at a discount', () => {
    const without = graphCandidates('crr', graph);
    expect(without.some((candidate) => candidate.docNo === 'A.1.4')).toBe(false);
    const withHop = graphCandidates('crr', graph, { hopRelations: ['is_a_type_of'] });
    const hopped = withHop.find((candidate) => candidate.docNo === 'A.1.4');
    expect(hopped).toBeDefined();
    expect(hopped!.coverage).toBe(0); // hopped mentions never count as query coverage
  });

  it('returns [] when nothing resolves, and respects the limit', () => {
    expect(graphCandidates('unrelated words', graph)).toEqual([]);
    expect(graphCandidates('crr grove', graph, { limit: 1 })).toHaveLength(1);
  });
});

describe('rerankWithinTiers (SEARCH-60 Arm B)', () => {
  const docNoOf = (id: number) => documents[id].doc_no;
  const idOf = (docNo: string) => documents.find((document) => document.doc_no === docNo)!.id;
  const hit = (docNo: string, score: number, provenance?: AtlasSearchHit['provenance']): AtlasSearchHit => ({
    id: idOf(docNo),
    score,
    terms: [],
    fields: [],
    ...(provenance ? { provenance } : {}),
  });

  it('reorders within a tier by the graph signal but never across tiers', () => {
    const hits = [
      hit('A.1.3', 10, 'strict'), // no crr signal
      hit('A.1.1', 9, 'strict'), // strong crr signal
      hit('A.1.2', 5, 'relaxed'), // crr+grove signal
      hit('A.1', 4.9, 'relaxed'), // none
    ];
    const signal = graphSignal('crr', graph);
    const reranked = rerankWithinTiers(hits, docNoOf, signal, 0.5);
    // Within strict: A.1.1 overtakes (9 * 1.5 > 10); relaxed keeps its order and
    // stays behind every strict row.
    expect(reranked.map((entry) => docNoOf(entry.id))).toEqual(['A.1.1', 'A.1.3', 'A.1.2', 'A.1']);
    expect(reranked.slice(0, 2).every((entry) => entry.provenance === 'strict')).toBe(true);
  });

  it('λ = 0 and a zero-signal block are the identity', () => {
    const hits = [hit('A.1.3', 3, 'strict'), hit('A.1', 2, 'strict')];
    expect(rerankWithinTiers(hits, docNoOf, graphSignal('crr', graph), 0)).toBe(hits);
    const untouched = rerankWithinTiers(hits, docNoOf, () => 0, 0.5);
    expect(untouched.map((entry) => docNoOf(entry.id))).toEqual(['A.1.3', 'A.1']);
  });
});
