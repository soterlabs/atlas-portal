import { describe, expect, it } from 'vitest';
import { buildEntityLexicon } from '../entity-lexicon';
import { flattenAtlasDocuments } from '../flatten-documents';
import { computeDocumentFrequency, computeInheritedKeywords } from '../inherited-keywords';
import { createDoc } from './fixtures';

// Grove is an agent (child of the agent root); "governance" is a generic word used
// widely in own text; the CRR doc under Grove never mentions "grove" itself.
const tree = [
  createDoc('Scope', 'A.1', 'The Governance Scope', 'Governance rules. More governance text.', {
    articles: [createDoc('Article', 'A.1.1', 'Voting', 'Votes are governance actions.')],
  }),
  createDoc('Scope', 'A.6', 'The Agent Scope', 'Agents live here.', {
    articles: [
      createDoc('Core', 'A.6.1', 'List Of Prime Agent Artifacts', 'The agents.', {
        articles: [
          createDoc('Core', 'A.6.1.1', 'Grove', 'An agent focused on credit.', {
            articles: [
              createDoc('Core', 'A.6.1.1.1', 'CRR', 'The capital ratio requirement value is 1.2.'),
              createDoc('Core', 'A.6.1.1.2', 'Grove Notes', 'Notes mention grove explicitly.'),
            ],
          }),
        ],
      }),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);
const lexicon = buildEntityLexicon(documents);
const df = computeDocumentFrequency(documents);
const inherited = computeInheritedKeywords(documents, {
  dfThreshold: 1,
  entityLexicon: lexicon,
  documentFrequency: df,
});
const byDocNo = (docNo: string) => inherited.get(documents.find((d) => d.doc_no === docNo)!.id);

describe('computeInheritedKeywords (SEARCH-56)', () => {
  it('a document under an agent inherits the agent name it never mentions', () => {
    expect(byDocNo('A.6.1.1.1')).toContain('grove');
  });

  it('generic ancestor words never transfer — the SEARCH-08 flooding guard', () => {
    // "governance" is in the lexicon? No — scope tokens are entities. The Governance
    // Scope IS an entity root, so its token transfers by the entity rule; the guard
    // is about non-entity generic words: "votes"/"rules" style tokens with high DF.
    const voting = byDocNo('A.1.1');
    expect(voting ?? []).not.toContain('rules');
  });

  it('a document already containing the token inherits nothing for it', () => {
    expect(byDocNo('A.6.1.1.2') ?? []).not.toContain('grove');
  });

  it('tokens deduplicate down the path and stopwords never appear', () => {
    for (const tokens of inherited.values()) {
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('of');
    }
  });
});
