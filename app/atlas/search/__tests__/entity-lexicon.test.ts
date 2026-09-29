import { describe, expect, it } from 'vitest';
import { buildEntityLexicon, detectEntityQuery } from '../entity-lexicon';
import { flattenAtlasDocuments } from '../flatten-documents';
import { createDoc } from './fixtures';

// Scopes are roots; agents are children of the "List Of Prime Agent Artifacts" node,
// exactly as the markdown importer defines them.
const tree = [
  createDoc('Scope', 'A.1', 'The Governance Scope', 'governance body', {
    articles: [createDoc('Article', 'A.1.1', 'Voting', 'votes')],
  }),
  createDoc('Scope', 'A.6', 'The Agent Scope', 'agents body', {
    articles: [
      createDoc('Core', 'A.6.1', 'List Of Prime Agent Artifacts', 'the agents', {
        articles: [
          createDoc('Core', 'A.6.1.1', 'Sparkle', 'agent one', {
            articles: [createDoc('Core', 'A.6.1.1.1', 'Savings Vault', 'vault yields')],
          }),
          createDoc('Core', 'A.6.1.2', 'Grove Finance', 'agent two'),
          // Shares the "finance" token with Grove Finance: that token must drop.
          createDoc('Core', 'A.6.1.3', 'Meadow Finance', 'agent three'),
        ],
      }),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);
const lexicon = buildEntityLexicon(documents);

describe('buildEntityLexicon (SEARCH-52)', () => {
  it('derives agents from the agent-root children and scopes from the roots', () => {
    expect(lexicon.byToken.get('sparkle')?.kind).toBe('agent');
    expect(lexicon.byToken.get('governance')?.kind).toBe('scope');
    expect(lexicon.byToken.get('governance')?.docNo).toBe('A.1');
  });

  it('drops generic name filler and ambiguous tokens', () => {
    expect(lexicon.byToken.has('scope')).toBe(false); // generic
    expect(lexicon.byToken.has('the')).toBe(false); // stopword
    expect(lexicon.byToken.has('finance')).toBe(false); // claimed by two agents
    expect(lexicon.byToken.get('grove')?.name).toBe('Grove Finance'); // distinctive part survives
    expect(lexicon.byToken.get('meadow')?.name).toBe('Meadow Finance');
  });

  it('does not treat interior documents as entities', () => {
    expect(lexicon.byToken.has('voting')).toBe(false);
    expect(lexicon.byToken.has('savings')).toBe(false);
  });
});

describe('detectEntityQuery (SEARCH-52)', () => {
  it('detects one entity plus concept tokens', () => {
    const detected = detectEntityQuery(['sparkle', 'checklist'], lexicon);
    expect(detected?.entity.name).toBe('Sparkle');
    expect(detected?.conceptTokens).toEqual(['checklist']);
  });

  it('returns null for entity-only, concept-only, or two-entity queries', () => {
    expect(detectEntityQuery(['sparkle'], lexicon)).toBeNull();
    expect(detectEntityQuery(['checklist', 'steps'], lexicon)).toBeNull();
    expect(detectEntityQuery(['sparkle', 'grove', 'checklist'], lexicon)).toBeNull();
  });

  it('a repeated mention of the same entity still counts as one', () => {
    const detected = detectEntityQuery(['sparkle', 'sparkle', 'vault'], lexicon);
    expect(detected?.entity.name).toBe('Sparkle');
    expect(detected?.conceptTokens).toEqual(['vault']);
  });
});
