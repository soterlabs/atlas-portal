import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import {
  CO_MENTION_MIN_WEIGHT,
  type GraphArtifact,
  type GraphRawFiles,
  buildGraphArtifact,
  toGraph,
  tryLoadGraph,
} from '../graph-artifact';
import { corpusHash } from '../prebuilt-index';
import { createDoc } from './fixtures';

const tree = [
  createDoc('Scope', 'A.1', 'Governance', 'Governance text.', {
    articles: [createDoc('Article', 'A.1.1', 'Voting', 'Voting text.')],
  }),
  createDoc('Scope', 'A.2', 'Agents', 'Agents text.'),
];
const documents = flattenAtlasDocuments(tree);

const raw: GraphRawFiles = {
  meta: {
    atlas_version: '2026-09-04',
    schema_version: 2,
    opposition: { oppositional_relations: ['violates', 'bypasses'] },
  },
  sections: [{ id: 'A.1' }, { id: 'A.1.1' }, { id: 'A.2' }],
  entities: [
    {
      id: 'crr',
      name: 'CRR',
      aliases: ['Capital Ratio Requirement'],
      tier: 'concept',
      stands_for: 'Capital Ratio Requirement',
      mention_count: 5,
    },
    { id: 'grove', name: 'Grove', aliases: ['Société Grove'], tier: 'instance', stands_for: null, mention_count: 3 },
    // "shared" collides with grove's claim below; both surfaces must be dropped.
    { id: 'other', name: 'Shared Name', aliases: [], tier: 'concept', stands_for: null, mention_count: 1 },
    { id: 'grove2', name: 'Shared Name', aliases: [], tier: 'concept', stands_for: null, mention_count: 1 },
  ],
  mentions: [
    { entity: 'crr', section_id: 'A.1', count: 2 },
    { entity: 'crr', section_id: 'A.1.1', count: 1 },
    { entity: 'grove', section_id: 'A.2', count: 3 },
    { entity: 'unknown_entity', section_id: 'A.1', count: 1 },
  ],
  edges: [
    { s: 'A.1', r: 'contains', o: 'A.1.1', kind: 'section-section' },
    { s: 'A.1.1', r: 'references', o: 'A.2', kind: 'section-section' },
    { s: 'crr', r: 'applies_to', o: 'grove', kind: 'entity-entity', section_ids: ['A.1', 'A.1.1', 'A.2', 'A.1'] },
    { s: 'crr', r: 'exotic_relation', o: 'grove', kind: 'entity-entity', section_ids: ['A.1'] },
    { s: 'crr', r: 'co_mentioned_with', o: 'grove', kind: 'entity-entity', weight: 4 },
    { s: 'crr', r: 'opposite_of', o: 'other', kind: 'entity-entity', opposition_kind: 'antonym', section_ids: ['A.1'] },
    { s: 'crr', r: 'draws_on', o: 'grove', kind: 'entity-entity', canonical: 'uses', section_ids: ['A.1'] },
    {
      s: 'crr',
      r: 'requirement',
      o: 'A.1.1',
      kind: 'entity-section',
      canonical: 'has_requirement',
      basis: 'structural',
      section_ids: ['A.1.1'],
    },
    {
      s: 'A.2',
      r: 'defined_in',
      o: 'grove',
      kind: 'entity-section',
      canonical: 'defines',
      basis: 'structural',
      swapped: true,
      section_ids: ['A.2'],
    },
    { s: 'crr', r: 'co_mentioned_with', o: 'other', kind: 'entity-entity', weight: CO_MENTION_MIN_WEIGHT - 1 },
  ],
  relations: [
    { name: 'uses', members: ['uses', 'draws_on'], oppositional: false },
    { name: 'blocks', members: ['blocks'], oppositional: true },
  ],
};

describe('buildGraphArtifact (SEARCH-59)', () => {
  const { artifact, report } = buildGraphArtifact(raw, documents, 'hash123');

  it('folds all surface forms into the alias map and drops collisions entirely', () => {
    expect(artifact.aliases['crr']).toBe('crr');
    expect(artifact.aliases['capital ratio requirement']).toBe('crr');
    expect(artifact.aliases['societe grove']).toBe('grove'); // accent folded
    expect(artifact.aliases['shared name']).toBeUndefined();
    expect(report.aliasCollisionsDropped).toEqual(['shared name']);
  });

  it('keeps postings per entity and skips mentions of unknown entities', () => {
    expect(artifact.postings['crr']).toEqual([
      ['A.1', 2],
      ['A.1.1', 1],
    ]);
    expect(artifact.postings['unknown_entity']).toBeUndefined();
    expect(report.postingsRows).toBe(3);
  });

  it('keeps ALL typed relations with evidence capped at 3, and splits references from contains', () => {
    expect(artifact.typed).toEqual([
      ['crr', 'applies_to', 'grove', ['A.1', 'A.1.1', 'A.2']],
      ['crr', 'exotic_relation', 'grove', ['A.1']],
      ['crr', 'uses', 'grove', ['A.1'], 'draws_on'],
    ]);
    expect(report.typedRelations).toEqual([
      // Aspect canonicals count into the inventory alongside entity-entity ones.
      ['applies_to', 1],
      ['defines', 1],
      ['exotic_relation', 1],
      ['has_requirement', 1],
      ['uses', 1],
    ]);
    expect(artifact.references).toEqual([['A.1.1', 'A.2']]);
  });

  it('keys typed edges by canonical with the wording kept, and normalizes aspects (SEARCH-65)', () => {
    expect(artifact.typed).toContainEqual(['crr', 'uses', 'grove', ['A.1'], 'draws_on']);
    // Aspect facts: (entity, canonical, section, wording) — the swapped defines
    // edge stores the section as subject and still normalizes correctly.
    expect(artifact.aspects).toEqual([
      ['crr', 'has_requirement', 'A.1.1', 'requirement'],
      ['grove', 'defines', 'A.2', 'defined in'],
    ]);
    expect(artifact.relations).toEqual([
      ['uses', ['uses', 'draws_on'], 0],
      ['blocks', ['blocks'], 1],
    ]);
    // With relations.json present the oppositional list is canonical-level.
    expect(artifact.oppositionalRelations).toEqual(['blocks']);
    expect(report.aspects).toBe(2);
    expect(report.canonicalRelations).toBe(2);
  });

  it('parses DP-GR8 opposites and the oppositional relation list', () => {
    expect(artifact.opposites).toEqual([['crr', 'other', 'a', ['A.1']]]);
    // relations.json present → the canonical-level list wins over meta wordings.
    expect(artifact.oppositionalRelations).toEqual(['blocks']);
    expect(report.opposites).toBe(1);
  });

  it('thresholds co-mentions by weight', () => {
    expect(artifact.coMentions).toEqual([['crr', 'grove', 4]]);
    expect(report.coMentionsDroppedBelowWeight).toBe(1);
  });

  it('encodes entity tier, mention count and stands_for', () => {
    expect(artifact.entities['crr']).toEqual(['c', 5, 'Capital Ratio Requirement', 'CRR']);
    expect(artifact.entities['grove']).toEqual(['i', 3, '', 'Grove']);
  });

  it('refuses a corpus that does not match the KG sections', () => {
    const drifted = raw.sections.concat([{ id: 'A.9.9' }]);
    expect(() => buildGraphArtifact({ ...raw, sections: drifted }, documents, 'x')).toThrow(/do not match/);
  });

  it('tolerates documents added to the Atlas after the graph was generated (SEARCH-79)', () => {
    // A larger corpus builds: the new document simply has no graph features.
    const grown = flattenAtlasDocuments([...tree, createDoc('Scope', 'A.3', 'New Scope', 'Added after the graph.')]);
    const built = buildGraphArtifact(raw, grown, 'x');
    expect(built.report.uncoveredDocuments).toBe(1);
    // The graph itself is unchanged and functional; the new document is simply absent.
    expect(Object.keys(built.artifact.entities)).toContain('crr');
    expect(toGraph(built.artifact).postingsOf.has('A.3')).toBe(false);
    // The exact pairing reports zero uncovered.
    expect(buildGraphArtifact(raw, documents, 'x').report.uncoveredDocuments).toBe(0);
  });
});

describe('toGraph (SEARCH-59)', () => {
  const graph = toGraph(buildGraphArtifact(raw, documents, 'hash123').artifact);

  it('builds bidirectional typed and citation lookups', () => {
    expect(graph.typedFrom.get('crr')?.map((edge) => edge.r)).toEqual(['applies_to', 'exotic_relation', 'uses']);
    expect(graph.typedTo.get('grove')?.[0]).toEqual({ r: 'applies_to', s: 'crr', sections: ['A.1', 'A.1.1', 'A.2'] });
    expect(graph.cites.get('A.1.1')).toEqual(['A.2']);
    expect(graph.citedBy.get('A.2')).toEqual(['A.1.1']);
  });

  it('exposes co-mentions from both endpoints, weight-descending', () => {
    expect(graph.coMentionsOf.get('crr')).toEqual([['grove', 4]]);
    expect(graph.coMentionsOf.get('grove')).toEqual([['crr', 4]]);
  });

  it('exposes aspects, the vocabulary, and typed wording through toGraph (SEARCH-65)', () => {
    expect(graph.aspectsOf.get('crr')).toEqual([
      { canonical: 'has_requirement', section: 'A.1.1', wording: 'requirement' },
    ]);
    expect(graph.aspectsOf.get('grove')).toEqual([{ canonical: 'defines', section: 'A.2', wording: 'defined in' }]);
    expect(graph.relations.find((relation) => relation.name === 'blocks')?.oppositional).toBe(true);
    expect(graph.typedFrom.get('crr')?.find((edge) => edge.r === 'uses')?.wording).toBe('draws_on');
  });

  it('exposes opposites from both directions and the oppositional set', () => {
    expect(graph.oppositeOf.get('crr')).toEqual([{ other: 'other', kind: 'antonym', sections: ['A.1'] }]);
    expect(graph.oppositeOf.get('other')).toEqual([{ other: 'crr', kind: 'antonym', sections: ['A.1'] }]);
    expect(graph.oppositionalRelations.has('blocks')).toBe(true);
  });

  it('decodes entity metadata', () => {
    expect(graph.entity.get('crr')).toEqual({
      tier: 'concept',
      mentions: 5,
      standsFor: 'Capital Ratio Requirement',
      name: 'CRR',
    });
    expect(graph.entity.get('grove')?.standsFor).toBeNull();
  });
});

describe('tryLoadGraph (SEARCH-59)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const artifactFor = async (): Promise<GraphArtifact> => {
    const hash = await corpusHash(tree);
    return buildGraphArtifact(raw, documents, hash!).artifact;
  };
  const stubFetch = (body: unknown, ok = true) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body })),
    );
  };

  it('loads a matching artifact into a graph', async () => {
    stubFetch(await artifactFor());
    const graph = await tryLoadGraph(tree);
    expect(graph?.aliasOf.get('capital ratio requirement')).toBe('crr');
    expect(graph?.postingsOf.get('crr')).toHaveLength(2);
  });

  it('rejects a stale corpus hash, a malformed shape, and a failed fetch — always null, never a throw', async () => {
    stubFetch({ ...(await artifactFor()), corpusHash: 'deadbeef' });
    expect(await tryLoadGraph(tree)).toBeNull();

    stubFetch({ version: 1, corpusHash: 'x' }); // missing fields
    expect(await tryLoadGraph(tree)).toBeNull();

    stubFetch({}, false);
    expect(await tryLoadGraph(tree)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await tryLoadGraph(tree)).toBeNull();
  });

  it('reports an absent artifact, naming the features that stay off', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    expect(await tryLoadGraph(tree)).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/graph artifact.*404.*Related/i));
    info.mockRestore();
  });

  it('reports a stale artifact naming both hashes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    stubFetch({ ...(await artifactFor()), corpusHash: 'f'.repeat(64) });
    expect(await tryLoadGraph(tree)).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/stale.*ffffffffffff/i));
    info.mockRestore();
  });

  it('shape-checks before hashing: a malformed artifact never touches WebCrypto', async () => {
    stubFetch({ nonsense: true });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    expect(await tryLoadGraph(tree)).toBeNull();
    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });
});
