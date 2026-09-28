import { describe, expect, it } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import { GENERIC_MENTION_CEILING, detectGraphInterpretations } from '../interpretation-chips';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Rules', 'Rules text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'CRR Definition', 'Definition.'),
      createDoc('Article', 'A.1.2', 'Cash Rules', 'Cash.'),
      createDoc('Article', 'A.1.3', 'Generic Home', 'Generic.'),
    ],
  }),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.1.2' }, { id: 'A.1.3' }],
  entities: [
    {
      id: 'crr',
      name: 'CRR',
      aliases: ['Capital Ratio Requirement'],
      tier: 'concept',
      stands_for: 'Capital Ratio Requirement',
      mention_count: 10,
    },
    {
      id: 'cash_stablecoins',
      name: 'Cash Stablecoins',
      aliases: [],
      tier: 'concept',
      stands_for: null,
      mention_count: 3,
    },
    {
      id: 'instance',
      name: 'Instance',
      aliases: [],
      tier: 'concept',
      stands_for: 'Instance Thing',
      mention_count: GENERIC_MENTION_CEILING + 1,
    },
    {
      id: 'hyper_target',
      name: 'Hyper Target',
      aliases: [],
      tier: 'concept',
      stands_for: null,
      mention_count: GENERIC_MENTION_CEILING + 1,
    },
  ],
  mentions: [
    { entity: 'crr', section_id: 'A.1.1', count: 4 },
    { entity: 'cash_stablecoins', section_id: 'A.1.2', count: 2 },
    { entity: 'instance', section_id: 'A.1.3', count: 9 },
  ],
  edges: [
    {
      s: 'crr',
      r: 'opposite_of',
      o: 'cash_stablecoins',
      kind: 'entity-entity',
      opposition_kind: 'antonym',
      section_ids: ['A.1.2'],
    },
    { s: 'crr', r: 'applies_to', o: 'cash_stablecoins', kind: 'entity-entity', section_ids: ['A.1.2'] },
    { s: 'crr', r: 'applies_to', o: 'hyper_target', kind: 'entity-entity', section_ids: ['A.1.3'] },
    { s: 'crr', r: 'reverts_with', o: 'cash_stablecoins', kind: 'entity-entity', section_ids: ['A.1.2'] },
  ],
};
const graph = toGraph(buildGraphArtifact(raw, documents, 'hash').artifact);

describe('detectGraphInterpretations (SEARCH-62)', () => {
  it('offers the spelled-out expansion, preserving the rest of the query', () => {
    const chips = detectGraphInterpretations('crr osero', graph);
    expect(chips).toContainEqual({
      kind: 'expansion',
      label: '“Capital Ratio Requirement osero”',
      rewrite: 'Capital Ratio Requirement osero',
    });
  });

  it('never offers an expansion when the user already typed the phrase', () => {
    const chips = detectGraphInterpretations('capital ratio requirement', graph);
    expect(chips.every((chip) => chip.kind !== 'expansion')).toBe(true);
  });

  it('entity-only queries get relation chips from core relations, generic targets skipped', () => {
    const chips = detectGraphInterpretations('crr', graph);
    const relations = chips.filter((chip) => chip.kind === 'relation');
    // cash_stablecoins via applies_to; hyper_target is above the ceiling and
    // reverts_with is not a core relation.
    expect(relations).toEqual([
      {
        kind: 'relation',
        label: '“Cash Stablecoins” — Capital Ratio Requirement applies to',
        rewrite: 'Cash Stablecoins',
      },
    ]);
  });

  it('offers a recorded opposite as a labeled chip (SEARCH-64)', () => {
    const chips = detectGraphInterpretations('crr', graph);
    expect(chips).toContainEqual({
      kind: 'opposite',
      label: '“Cash Stablecoins” — the opposite of Capital Ratio Requirement',
      rewrite: 'Cash Stablecoins',
    });
  });

  it('entity+concept queries get no relation detours', () => {
    const chips = detectGraphInterpretations('crr osero', graph);
    expect(chips.every((chip) => chip.kind !== 'relation')).toBe(true);
  });

  it('hyper-generic entities and unresolvable text produce nothing', () => {
    expect(detectGraphInterpretations('instance', graph)).toEqual([]);
    expect(detectGraphInterpretations('nothing here', graph)).toEqual([]);
  });
});
