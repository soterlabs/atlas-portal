/**
 * SEARCH-59: the compact GraphRAG artifact — the Atlas knowledge graph
 * (`data/graphrag/`, schema v2) reduced to what retrieval and UI consumers need,
 * corpus-hash pinned like every artifact. The raw contract files are ~46MB; this
 * module derives the low-MB subset: a folded alias map, entity → section postings,
 * entity metadata, all typed edges keyed by the DP-GR9 canonical relation, the
 * DP-GR10 aspect facts, the relation vocabulary, explicit `references`
 * citations, and weighted co-mentions. (SEARCH-65 retired the hand-picked
 * CORE_TYPED_RELATIONS whitelist — the judged closed vocabulary replaces it.)
 *
 * Mention QUOTES are deliberately excluded: the browser already holds every
 * document's text, so the sentence evidencing a mention is derivable at render
 * time with the existing snippet machinery and the entity's surface forms —
 * shipping 89k verbatim quotes would dominate the artifact for no information
 * the client lacks.
 *
 * Pure functions; the build script and the tests share `buildGraphArtifact`.
 */
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { corpusHash, shortHash, staleArtifactWarning } from './prebuilt-index';

export interface GraphArtifact {
  version: 1;
  /** SHA-256 of `JSON.stringify(scopeTrees)` at build time — same pin as every artifact. */
  corpusHash: string;
  /** The Atlas snapshot the raw KG files name (`meta.json.atlas_version`). */
  atlasVersion: string;
  /** entity id → [tier 'c'|'i', total mention count, stands_for or '', display name]. */
  entities: Record<string, [tier: 'c' | 'i', mentions: number, standsFor: string, name: string]>;
  /** folded surface form → entity id (name, aliases, stands_for; collisions dropped). */
  aliases: Record<string, string>;
  /** entity id → [doc_no, occurrence count] postings, mention order preserved. */
  postings: Record<string, Array<[docNo: string, count: number]>>;
  /**
   * ALL typed entity-entity edges: [subject, relation, object, evidence doc_nos
   * (≤3), display wording when it differs from the relation]. The relation slot
   * carries the DP-GR9 canonical name where the data has one, else the wording.
   */
  typed: Array<[s: string, r: string, o: string, sections: string[], wording?: string]>;
  /** Explicit section citations: [citing doc_no, cited doc_no]. */
  references: Array<[from: string, to: string]>;
  /** Weighted co-mention pairs: [entity, entity, weight]. */
  coMentions: Array<[a: string, b: string, weight: number]>;
  /**
   * DP-GR8 symmetric opposite pairs: [a, b, kind 'a'(ntonym)|'f'(ailure),
   * co-occurrence doc_nos]. Absent in artifacts built before SEARCH-64.
   */
  opposites?: Array<[a: string, b: string, kind: 'a' | 'f', sections: string[]]>;
  /** Relation wordings judged oppositional (`meta.json.opposition`). */
  oppositionalRelations?: string[];
  /**
   * DP-GR9 canonical vocabulary: [name, member wordings, oppositional 0|1].
   * Absent in artifacts built before SEARCH-65.
   */
  relations?: Array<[name: string, members: string[], oppositional: 0 | 1]>;
  /**
   * DP-GR10 entity-section facts: [entity, canonical relation, section doc_no,
   * display wording] — the section IS the answer ("AD Voting Responsibility"
   * gives [ad, has_duty, A.1.6.2.1, 'voting responsibility']).
   */
  aspects?: Array<[entity: string, canonical: string, section: string, wording: string]>;
}

export interface GraphBuildReport {
  entities: number;
  aliases: number;
  aliasCollisionsDropped: string[];
  postingsRows: number;
  typedKept: number;
  /** Full relation inventory of the kept typed edges, count-descending. */
  typedRelations: Array<[relation: string, count: number]>;
  references: number;
  coMentions: number;
  coMentionsDroppedBelowWeight: number;
  opposites: number;
  oppositionalRelations: number;
  aspects: number;
  canonicalRelations: number;
  /** Corpus documents the graph has no section for (added to the Atlas after the graph was generated). */
  uncoveredDocuments: number;
}

/** The raw contract files (schema v2) as parsed JSON. */
export interface GraphRawFiles {
  meta: {
    atlas_version: string;
    schema_version: number;
    opposition?: { oppositional_relations: string[] };
  };
  sections: Array<{ id: string }>;
  entities: Array<{
    id: string;
    name: string;
    aliases: string[];
    tier: 'concept' | 'instance';
    stands_for: string | null;
    mention_count: number;
  }>;
  mentions: Array<{ entity: string; section_id: string; count: number }>;
  edges: Array<{
    s: string;
    r: string;
    o: string;
    kind: string;
    section_ids?: string[];
    weight?: number;
    opposition_kind?: string;
    /** DP-GR9: the closed-vocabulary relation name; `r` stays the wording. */
    canonical?: string;
    basis?: string;
    swapped?: boolean;
  }>;
  /** DP-GR9 vocabulary (`relations.json`): optional so older file sets still build. */
  relations?: Array<{ name: string; members: string[]; oppositional: boolean }>;
}

/** Co-mention pairs below this weight are noise for every planned consumer. */
export const CO_MENTION_MIN_WEIGHT = 2;

const foldAlias = (surface: string): string => foldText(surface).replace(/\s+/g, ' ').trim();

/**
 * Derives the artifact. Throws when the KG sections and the corpus disagree —
 * a stale pairing must fail the build, never produce a silently wrong artifact.
 */
export function buildGraphArtifact(
  raw: GraphRawFiles,
  documents: FlatAtlasDocument[],
  pinnedCorpusHash: string,
): { artifact: GraphArtifact; report: GraphBuildReport } {
  const docNos = new Set(documents.map((document) => document.doc_no));
  const missing = raw.sections.filter((section) => !docNos.has(section.id));
  if (missing.length > 0) {
    throw new Error(
      `graph sections do not match the corpus: ${missing.length} graph-only ids ` +
        `(first: ${missing[0].id}) — the graph was generated from a different Atlas`,
    );
  }
  // The corpus MAY be larger than the graph (SEARCH-79): documents added to the
  // Atlas after the graph data was generated simply carry no graph features
  // until the graph is regenerated. Only graph-only ids are a stale pairing —
  // their edges would point at documents that do not exist.
  const uncoveredDocuments = docNos.size - raw.sections.length;

  const entities: GraphArtifact['entities'] = {};
  for (const entity of raw.entities) {
    entities[entity.id] = [
      entity.tier === 'instance' ? 'i' : 'c',
      entity.mention_count,
      entity.stands_for ?? '',
      entity.name,
    ];
  }

  // null marks a folded surface claimed by two entities: ambiguous, dropped (the
  // SEARCH-52 collision rule).
  const claims = new Map<string, string | null>();
  for (const entity of raw.entities) {
    const surfaces = [entity.name, ...entity.aliases, ...(entity.stands_for ? [entity.stands_for] : [])];
    for (const surface of surfaces) {
      const folded = foldAlias(surface);
      if (folded.length < 2) continue;
      const existing = claims.get(folded);
      if (existing === undefined) claims.set(folded, entity.id);
      else if (existing !== null && existing !== entity.id) claims.set(folded, null);
    }
  }
  const aliases: GraphArtifact['aliases'] = {};
  const aliasCollisionsDropped: string[] = [];
  for (const [folded, id] of claims) {
    if (id === null) aliasCollisionsDropped.push(folded);
    else aliases[folded] = id;
  }
  aliasCollisionsDropped.sort();

  const postings: GraphArtifact['postings'] = {};
  let postingsRows = 0;
  for (const mention of raw.mentions) {
    if (!entities[mention.entity]) continue;
    (postings[mention.entity] ??= []).push([mention.section_id, mention.count]);
    postingsRows += 1;
  }

  const typed: GraphArtifact['typed'] = [];
  const relationCounts = new Map<string, number>();
  const references: GraphArtifact['references'] = [];
  const coMentions: GraphArtifact['coMentions'] = [];
  const opposites: NonNullable<GraphArtifact['opposites']> = [];
  let coMentionsDroppedBelowWeight = 0;
  const aspects: NonNullable<GraphArtifact['aspects']> = [];
  for (const edge of raw.edges) {
    if (edge.kind === 'section-section') {
      // `contains` duplicates the tree the browser already has.
      if (edge.r === 'references') references.push([edge.s, edge.o]);
      continue;
    }
    if (edge.kind === 'entity-section' && edge.canonical) {
      // DP-GR10: one endpoint is a section (which one depends on the canonical
      // direction — `defines` stores the section as subject); normalize to
      // (entity, canonical, section) and keep the title wording for display.
      const sSection = docNos.has(edge.s);
      const entity = sSection ? edge.o : edge.s;
      const section = sSection ? edge.s : edge.o;
      const wording = edge.r === edge.canonical ? edge.canonical.replace(/_/g, ' ') : edge.r.replace(/_/g, ' ');
      aspects.push([entity, edge.canonical, section, wording]);
      relationCounts.set(edge.canonical, (relationCounts.get(edge.canonical) ?? 0) + 1);
      continue;
    }
    if (edge.kind !== 'entity-entity') continue;
    if (edge.r === 'co_mentioned_with') {
      const weight = edge.weight ?? 1;
      if (weight >= CO_MENTION_MIN_WEIGHT) coMentions.push([edge.s, edge.o, weight]);
      else coMentionsDroppedBelowWeight += 1;
      continue;
    }
    if (edge.r === 'opposite_of') {
      // DP-GR8: symmetric, stored once (s < o); kind 'antonym' or 'failure'.
      opposites.push([edge.s, edge.o, edge.opposition_kind === 'failure' ? 'f' : 'a', edge.section_ids ?? []]);
      continue;
    }
    const relation = edge.canonical ?? edge.r;
    const evidence = (edge.section_ids ?? []).slice(0, 3);
    if (edge.canonical && edge.r !== edge.canonical) typed.push([edge.s, relation, edge.o, evidence, edge.r]);
    else typed.push([edge.s, relation, edge.o, evidence]);
    relationCounts.set(relation, (relationCounts.get(relation) ?? 0) + 1);
  }

  const artifact: GraphArtifact = {
    version: 1,
    corpusHash: pinnedCorpusHash,
    atlasVersion: raw.meta.atlas_version,
    entities,
    aliases,
    postings,
    typed,
    references,
    coMentions,
    opposites,
    oppositionalRelations: raw.relations
      ? raw.relations.filter((relation) => relation.oppositional).map((relation) => relation.name)
      : (raw.meta.opposition?.oppositional_relations ?? []),
    relations: (raw.relations ?? []).map(
      (relation) => [relation.name, relation.members, relation.oppositional ? 1 : 0] as [string, string[], 0 | 1],
    ),
    aspects,
  };
  const report: GraphBuildReport = {
    entities: raw.entities.length,
    aliases: Object.keys(aliases).length,
    aliasCollisionsDropped,
    postingsRows,
    typedKept: typed.length,
    typedRelations: [...relationCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    references: references.length,
    coMentions: coMentions.length,
    coMentionsDroppedBelowWeight,
    opposites: opposites.length,
    oppositionalRelations: raw.meta.opposition?.oppositional_relations.length ?? 0,
    aspects: aspects.length,
    canonicalRelations: raw.relations?.length ?? 0,
    uncoveredDocuments,
  };
  return { artifact, report };
}

/** The artifact with lookup structures built, ready for consumers. */
export interface AtlasGraph {
  atlasVersion: string;
  /** folded surface form → entity id. */
  aliasOf: Map<string, string>;
  entity: Map<string, { tier: 'concept' | 'instance'; mentions: number; standsFor: string | null; name: string }>;
  /** entity id → [doc_no, count] postings. */
  postingsOf: Map<string, Array<[string, number]>>;
  /** entity id → outgoing and incoming typed edges (r = canonical where recorded). */
  typedFrom: Map<string, Array<{ r: string; o: string; sections: string[]; wording?: string }>>;
  typedTo: Map<string, Array<{ r: string; s: string; sections: string[]; wording?: string }>>;
  /** doc_no → doc_nos it cites / doc_nos citing it. */
  cites: Map<string, string[]>;
  citedBy: Map<string, string[]>;
  /** entity id → co-mentioned [entity, weight], weight descending. */
  coMentionsOf: Map<string, Array<[string, number]>>;
  /** entity id → its opposites (both directions of the symmetric pairs). */
  oppositeOf: Map<string, Array<{ other: string; kind: 'antonym' | 'failure'; sections: string[] }>>;
  /** Relation wordings judged to mean the subject works AGAINST the object. */
  oppositionalRelations: Set<string>;
  /** DP-GR9 canonical vocabulary; empty for pre-SEARCH-65 artifacts. */
  relations: Array<{ name: string; members: string[]; oppositional: boolean }>;
  /** entity id → its DP-GR10 aspect facts (the section is the answer). */
  aspectsOf: Map<string, Array<{ canonical: string; section: string; wording: string }>>;
}

export function toGraph(artifact: GraphArtifact): AtlasGraph {
  const aliasOf = new Map(Object.entries(artifact.aliases));
  const entity = new Map(
    Object.entries(artifact.entities).map(([id, [tier, mentions, standsFor, name]]) => [
      id,
      {
        tier: tier === 'i' ? ('instance' as const) : ('concept' as const),
        mentions,
        standsFor: standsFor || null,
        name: name || id.replace(/_/g, ' '),
      },
    ]),
  );
  const postingsOf = new Map(Object.entries(artifact.postings));
  const typedFrom = new Map<string, Array<{ r: string; o: string; sections: string[]; wording?: string }>>();
  const typedTo = new Map<string, Array<{ r: string; s: string; sections: string[]; wording?: string }>>();
  for (const [s, r, o, sections, wording] of artifact.typed) {
    (typedFrom.get(s) ?? typedFrom.set(s, []).get(s)!).push({ r, o, sections, ...(wording ? { wording } : {}) });
    (typedTo.get(o) ?? typedTo.set(o, []).get(o)!).push({ r, s, sections, ...(wording ? { wording } : {}) });
  }
  const cites = new Map<string, string[]>();
  const citedBy = new Map<string, string[]>();
  for (const [from, to] of artifact.references) {
    (cites.get(from) ?? cites.set(from, []).get(from)!).push(to);
    (citedBy.get(to) ?? citedBy.set(to, []).get(to)!).push(from);
  }
  const coMentionsOf = new Map<string, Array<[string, number]>>();
  for (const [a, b, weight] of artifact.coMentions) {
    (coMentionsOf.get(a) ?? coMentionsOf.set(a, []).get(a)!).push([b, weight]);
    (coMentionsOf.get(b) ?? coMentionsOf.set(b, []).get(b)!).push([a, weight]);
  }
  for (const list of coMentionsOf.values()) list.sort((x, y) => y[1] - x[1]);
  const aspectsOf: AtlasGraph['aspectsOf'] = new Map();
  for (const [entity, canonical, section, wording] of artifact.aspects ?? []) {
    (aspectsOf.get(entity) ?? aspectsOf.set(entity, []).get(entity)!).push({ canonical, section, wording });
  }
  const oppositeOf: AtlasGraph['oppositeOf'] = new Map();
  for (const [a, b, kind, sections] of artifact.opposites ?? []) {
    const decoded = kind === 'f' ? ('failure' as const) : ('antonym' as const);
    (oppositeOf.get(a) ?? oppositeOf.set(a, []).get(a)!).push({ other: b, kind: decoded, sections });
    (oppositeOf.get(b) ?? oppositeOf.set(b, []).get(b)!).push({ other: a, kind: decoded, sections });
  }
  return {
    atlasVersion: artifact.atlasVersion,
    aliasOf,
    entity,
    postingsOf,
    typedFrom,
    typedTo,
    cites,
    citedBy,
    coMentionsOf,
    oppositeOf,
    oppositionalRelations: new Set(artifact.oppositionalRelations ?? []),
    relations: (artifact.relations ?? []).map(([name, members, oppositional]) => ({
      name,
      members,
      oppositional: oppositional === 1,
    })),
    aspectsOf,
  };
}

export const GRAPH_ARTIFACT_PATH = '/atlas-graph.json';

/** What the graph powers; named in every "off" message so the remedy is obvious from the console alone. */
const GRAPH_FEATURES = 'the Related section, suggestion chips and definition answers stay off';

/** The graph for exactly this tree, or null (absent, stale, malformed — never throws). */
export async function tryLoadGraph(scopeTrees: unknown): Promise<AtlasGraph | null> {
  try {
    // Fetch and shape-check FIRST, hash second — the abbreviation-artifact lesson.
    const response = await fetch(GRAPH_ARTIFACT_PATH);
    if (!response.ok) {
      staleArtifactWarning(
        `Graph artifact ${GRAPH_ARTIFACT_PATH} not served (HTTP ${response.status}); ${GRAPH_FEATURES}.`,
      );
      return null;
    }
    const artifact = (await response.json()) as GraphArtifact;
    if (
      artifact?.version !== 1 ||
      typeof artifact.corpusHash !== 'string' ||
      typeof artifact.atlasVersion !== 'string' ||
      typeof artifact.entities !== 'object' ||
      typeof artifact.aliases !== 'object' ||
      typeof artifact.postings !== 'object' ||
      !Array.isArray(artifact.typed) ||
      !Array.isArray(artifact.references) ||
      !Array.isArray(artifact.coMentions)
    ) {
      staleArtifactWarning(`Graph artifact ${GRAPH_ARTIFACT_PATH} has an unexpected shape; ${GRAPH_FEATURES}.`);
      return null;
    }
    const hash = await corpusHash(scopeTrees);
    if (!hash || artifact.corpusHash !== hash) {
      staleArtifactWarning(
        `Graph artifact is stale (artifact ${shortHash(artifact.corpusHash)} vs corpus ${shortHash(hash)}); ` +
          `${GRAPH_FEATURES}. Rebuild: npm run search:build-graph-artifact`,
      );
      return null;
    }
    return toGraph(artifact);
  } catch {
    return null;
  }
}
