import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { ANSWER_GENERIC_CEILING, answerTripleQuery } from '../graph-answers';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Delegates', 'Delegates scope.', {
    articles: [
      createDoc('Article', 'A.1.1', 'AD Responsibility', 'The duties list.'),
      createDoc('Article', 'A.1.2', 'AD Voting Responsibility', 'Voting duties.'),
      createDoc('Article', 'A.1.3', 'Budget Uses', 'The delegate uses the budget here.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.1.2' }, { id: 'A.1.3' }],
  entities: [
    { id: 'ad', name: 'Aligned Delegate', aliases: ['AD'], tier: 'concept', stands_for: null, mention_count: 20 },
    { id: 'budget', name: 'Budget', aliases: [], tier: 'concept', stands_for: null, mention_count: 5 },
    // 'duty' is BOTH an entity and a relation word — a case found in review.
    { id: 'duty', name: 'Duty', aliases: [], tier: 'concept', stands_for: null, mention_count: 3 },
    {
      id: 'generic',
      name: 'Generic',
      aliases: [],
      tier: 'concept',
      stands_for: null,
      mention_count: ANSWER_GENERIC_CEILING + 1,
    },
  ],
  mentions: [{ entity: 'ad', section_id: 'A.1.1', count: 2 }],
  edges: [
    // DP-GR10 aspect: the section IS the answer.
    {
      s: 'ad',
      r: 'responsibility',
      o: 'A.1.1',
      kind: 'entity-section',
      canonical: 'has_duty',
      basis: 'structural',
      section_ids: ['A.1.1'],
    },
    {
      s: 'ad',
      r: 'voting responsibility',
      o: 'A.1.2',
      kind: 'entity-section',
      canonical: 'has_duty',
      basis: 'structural',
      section_ids: ['A.1.2'],
    },
    // Canonical entity-entity fact with a display wording.
    {
      s: 'ad',
      r: 'draws_from',
      o: 'budget',
      kind: 'entity-entity',
      canonical: 'uses',
      basis: 'frequent',
      section_ids: ['A.1.3'],
    },
  ],
  relations: [
    { name: 'has_duty', members: ['responsibility', 'obligation', 'voting responsibility'], oppositional: false },
    { name: 'uses', members: ['uses', 'draws_from', 'leverages'], oppositional: false },
    { name: 'related_to', members: ['related_to'], oppositional: false },
  ],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'hash').artifact);

describe('answerTripleQuery (SEARCH-65)', () => {
  it('answers "aligned delegate duties" from aspect facts, stemming duties → has_duty', () => {
    const answer = answerTripleQuery('aligned delegate duties', graph);
    expect(answer?.entityName).toBe('Aligned Delegate');
    expect(answer?.relations).toEqual(['has_duty']);
    expect(answer?.rows).toEqual([
      {
        section: 'A.1.1',
        label: 'The related terms “Aligned Delegate” and “responsibility” are connected in this section.',
      },
      {
        section: 'A.1.2',
        label: 'The related terms “Aligned Delegate” and “voting responsibility” are connected in this section.',
      },
    ]);
  });

  it('answers when the relation word is itself an entity (aligned delegate duty)', () => {
    // 'duty' resolves as an entity and leaves no residual; the subject entity
    // must still get its has_duty facts from the other resolved surface.
    const answer = answerTripleQuery('aligned delegate duty', graph);
    expect(answer?.entityName).toBe('Aligned Delegate');
    expect(answer?.rows.map((row) => row.section)).toEqual(['A.1.1', 'A.1.2']);
  });

  it('matches member wordings and answers from entity-entity facts with their wording', () => {
    const answer = answerTripleQuery('ad uses', graph);
    expect(answer?.rows).toEqual([
      {
        section: 'A.1.3',
        label:
          'The related terms “Aligned Delegate” and “Budget” are connected in this section (Aligned Delegate draws from Budget).',
      },
    ]);
  });

  it('stays silent without an entity, without leftover words, or without a matching relation', () => {
    expect(answerTripleQuery('nothing resolves duties', graph)).toBeNull();
    expect(answerTripleQuery('aligned delegate', graph)).toBeNull();
    expect(answerTripleQuery('aligned delegate weather', graph)).toBeNull();
  });

  it('stays silent when the entity has no facts for the matched relation', () => {
    expect(answerTripleQuery('budget duties', graph)).toBeNull();
  });

  it('a hyper-generic entity answers nothing, and the corpus filter drops stale sections', () => {
    expect(answerTripleQuery('generic duties', graph)).toBeNull();
    const filtered = answerTripleQuery('aligned delegate duties', graph, (docNo) => docNo !== 'A.1.1');
    expect(filtered?.rows.map((row) => row.section)).toEqual(['A.1.2']);
  });

  it('bridges to a variant entity when the resolved one has no facts (SEARCH-76)', () => {
    // 'budget' resolves but has no duty facts; 'Core Budget' (name contains
    // the word) does — the answer carries the variant's own name.
    const bridged = {
      ...raw,
      entities: [
        ...raw.entities,
        {
          id: 'core_budget',
          name: 'Core Budget',
          aliases: [],
          tier: 'concept' as const,
          stands_for: null,
          mention_count: 8,
        },
      ],
      edges: [
        ...raw.edges,
        {
          s: 'core_budget',
          r: 'obligation',
          o: 'A.1.3',
          kind: 'entity-section',
          canonical: 'has_duty',
          basis: 'structural',
          section_ids: ['A.1.3'],
        },
      ],
    };
    const bridgedGraph = toGraph(buildGraphArtifact(bridged, documents, 'hash').artifact);
    const answer = answerTripleQuery('budget duties', bridgedGraph);
    expect(answer?.entityName).toBe('Core Budget');
    expect(answer?.rows).toEqual([
      { section: 'A.1.3', label: 'The related terms “Core Budget” and “obligation” are connected in this section.' },
    ]);
    // A direct fact always wins over any variant: the ad query is unchanged.
    expect(answerTripleQuery('aligned delegate duties', bridgedGraph)?.entityName).toBe('Aligned Delegate');
  });

  it('the coarse related_to bucket never matches', () => {
    expect(answerTripleQuery('aligned delegate related', graph)).toBeNull();
  });
});
