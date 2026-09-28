import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import { answerQuestion, parseQuestion } from '../question-answer';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Governance', 'Governance scope.', {
    articles: [
      createDoc(
        'Article',
        'A.1.1',
        'Core Facilitator',
        'The Core Facilitator stewards the governance process. More text.',
      ),
      createDoc('Article', 'A.1.2', 'Morpho Vaults', 'The vault registry.', {
        articles: [
          createDoc('Article', 'A.1.2.1', 'Grove Vault', 'A vault.'),
          createDoc('Article', 'A.1.2.2', 'Steakhouse Vault', 'Another vault.'),
          createDoc('Article', 'A.1.2.3', 'Bloom Vault', 'A third vault.'),
        ],
      }),
      createDoc('Article', 'A.1.3', 'Vault Rules', 'Rules text.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [
    { id: 'A.1' },
    { id: 'A.1.1' },
    { id: 'A.1.2' },
    { id: 'A.1.2.1' },
    { id: 'A.1.2.2' },
    { id: 'A.1.2.3' },
    { id: 'A.1.3' },
  ],
  entities: [
    { id: 'cf', name: 'Core Facilitator', aliases: ['CF'], tier: 'concept', stands_for: null, mention_count: 12 },
    { id: 'gov', name: 'Governance', aliases: [], tier: 'concept', stands_for: null, mention_count: 30 },
  ],
  mentions: [{ entity: 'cf', section_id: 'A.1.1', count: 4 }],
  edges: [
    {
      s: 'cf',
      r: 'defines',
      o: 'A.1.1',
      kind: 'entity-section',
      canonical: 'defines',
      basis: 'structural',
      section_ids: ['A.1.1'],
    },
  ],
  relations: [{ name: 'defines', members: ['defines', 'defined_in'], oppositional: false }],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'hash').artifact);

describe('parseQuestion (SEARCH-84)', () => {
  it('recognizes the closed template list, tolerant of case and punctuation', () => {
    expect(parseQuestion('Who is the Core Facilitator?')).toEqual({ kind: 'definition', subject: 'core facilitator' });
    expect(parseQuestion('what is governance')).toEqual({ kind: 'definition', subject: 'governance' });
    expect(parseQuestion('How many morpho vaults does sky allocate to?')).toEqual({
      kind: 'count',
      subject: 'morpho vaults',
    });
    expect(parseQuestion('how many vaults are there')).toEqual({ kind: 'count', subject: 'vaults' });
  });

  it('everything else is silence: no template, no subject, or an unwieldy subject', () => {
    expect(parseQuestion('governance process')).toBeNull();
    expect(parseQuestion('why is the vault empty')).toBeNull();
    expect(parseQuestion('what is')).toBeNull();
    expect(parseQuestion('how many')).toBeNull();
    expect(parseQuestion('what is one two three four five six seven')).toBeNull();
  });
});

describe('answerQuestion (SEARCH-84)', () => {
  it('answers a definition from the recorded defines fact, with provenance and preview', () => {
    const answer = answerQuestion({ kind: 'definition', subject: 'core facilitator' }, documents, graph);
    expect(answer).toMatchObject({ kind: 'definition', docNo: 'A.1.1', sectionName: 'Core Facilitator' });
    expect(answer?.text).toBe('Core Facilitator is defined in “Core Facilitator”.');
    expect(answer?.preview).toBe('The Core Facilitator stewards the governance process.');
  });

  it('stays silent when the subject is not fully accounted for, undefined, or the data is absent', () => {
    // 'core facilitator of vaults' resolves only partially — silence, not a guess.
    expect(answerQuestion({ kind: 'definition', subject: 'core facilitator vaults' }, documents, graph)).toBeNull();
    // 'governance' resolves but has no recorded definition.
    expect(answerQuestion({ kind: 'definition', subject: 'governance' }, documents, graph)).toBeNull();
    // No structural data loaded → silence.
    expect(answerQuestion({ kind: 'definition', subject: 'core facilitator' }, documents, null)).toBeNull();
  });

  it('counts direct children of the best-named directory, naming what it counted', () => {
    const answer = answerQuestion({ kind: 'count', subject: 'morpho vaults' }, documents, null);
    expect(answer).toMatchObject({ kind: 'count', docNo: 'A.1.2' });
    expect(answer?.text).toBe('3 documents filed directly under “Morpho Vaults” (A.1.2).');
  });

  it('a word-form subject still finds the registry; no directory means silence', () => {
    // 'vault' (singular) stems like 'Vaults'; 'Morpho Vaults' has children while
    // 'Vault Rules' has none — but 'vaults' alone matches BOTH names' stems, and
    // the fewest-extra-words rule must not pick a childless section.
    expect(answerQuestion({ kind: 'count', subject: 'vaults' }, documents, null)?.docNo).toBe('A.1.2');
    expect(answerQuestion({ kind: 'count', subject: 'unknown things' }, documents, null)).toBeNull();
  });
});
