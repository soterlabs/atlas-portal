/**
 * SEARCH-63: related documents with stated reasons — doc→doc discovery over the
 * SEARCH-59 graph. Navigation, never ranking: the result list's order is untouched;
 * this module only answers "given this document, what neighbors would a reader
 * want, and WHY" with a checkable reason per entry.
 *
 * Reason precedence (strongest evidence first):
 *   1. citations — this document cites / is cited by the other, explicitly;
 *   2. opposites (SEARCH-64/DP-GR8) — an entity here has a recorded opposite;
 *      the sections where both poles appear come first, then the opposite's
 *      top mention sections;
 *   3. typed edges — an entity mentioned here has a labeled relation whose
 *      evidence sections are other documents;
 *   4. shared entities — both documents mention the same informative entities
 *      (generic entities are downweighted exactly as in SEARCH-60's route).
 */
import type { AtlasGraph } from './graph-artifact';

export type RelatedReason =
  | { kind: 'cites' }
  | { kind: 'cited-by' }
  | { kind: 'opposite'; docEntity: string; opposite: string; oppositionKind: 'antonym' | 'failure' }
  | { kind: 'aspect'; entity: string; wording: string }
  | { kind: 'typed-edge'; subject: string; relation: string; object: string }
  | { kind: 'shared-entities'; entities: string[] };

export interface RelatedDocument {
  docNo: string;
  reason: RelatedReason;
}

/** Total entries returned per document. */
export const RELATED_CAP = 8;
/** Document entities considered for the shared/typed signals (most informative first). */
const TOP_DOC_ENTITIES = 6;
/** Shared-entity names shown in a reason. */
const REASON_ENTITY_NAMES = 2;

/** A frequent entity carries less signal per mention — the SEARCH-60 weighting. */
const informativeness = (mentions: number): number => 1 / Math.log2(2 + mentions);

/** Human display for an entity id: stands_for when recorded, else the recorded name. */
export function entityDisplayName(id: string, graph: AtlasGraph): string {
  const entity = graph.entity.get(id);
  return entity?.standsFor ?? entity?.name ?? id.replace(/_/g, ' ');
}

// The artifact stores entity → sections; doc→doc needs the inverse. Built once per
// graph instance and cached — the WeakMap dies with the graph.
const inverseCache = new WeakMap<AtlasGraph, Map<string, Array<[entity: string, count: number]>>>();
function entitiesOf(graph: AtlasGraph): Map<string, Array<[string, number]>> {
  let inverse = inverseCache.get(graph);
  if (!inverse) {
    inverse = new Map();
    for (const [entity, postings] of graph.postingsOf) {
      for (const [docNo, count] of postings) {
        const list = inverse.get(docNo);
        if (list) list.push([entity, count]);
        else inverse.set(docNo, [[entity, count]]);
      }
    }
    inverseCache.set(graph, inverse);
  }
  return inverse;
}

/**
 * The related documents for one doc_no, capped at RELATED_CAP, each with its
 * reason. `isKnownDocNo` filters targets to the current corpus (stale edge targets
 * degrade silently). Deterministic for a given graph.
 */
export function relatedDocuments(
  docNo: string,
  graph: AtlasGraph,
  isKnownDocNo: (candidate: string) => boolean = () => true,
): RelatedDocument[] {
  const related: RelatedDocument[] = [];
  const seen = new Set<string>([docNo]);
  const push = (candidate: string, reason: RelatedReason): boolean => {
    if (seen.has(candidate) || !isKnownDocNo(candidate)) return false;
    seen.add(candidate);
    related.push({ docNo: candidate, reason });
    return related.length >= RELATED_CAP;
  };

  // 1. Citations, both directions.
  for (const target of graph.cites.get(docNo) ?? []) {
    if (push(target, { kind: 'cites' })) return related;
  }
  for (const source of graph.citedBy.get(docNo) ?? []) {
    if (push(source, { kind: 'cited-by' })) return related;
  }

  // The document's own entities, most informative mention-mass first.
  const docEntities = (entitiesOf(graph).get(docNo) ?? [])
    .map(([entity, count]) => ({
      entity,
      weight: informativeness(graph.entity.get(entity)?.mentions ?? 0) * Math.log2(1 + count),
    }))
    .sort((a, b) => b.weight - a.weight || (a.entity < b.entity ? -1 : 1))
    .slice(0, TOP_DOC_ENTITIES);

  // 2. Opposites (SEARCH-64): the recorded opposite of one of this document's
  // entities — co-occurrence sections first, then the opposite's top mentions.
  for (const { entity } of docEntities) {
    for (const pair of graph.oppositeOf.get(entity) ?? []) {
      const reason: RelatedReason = {
        kind: 'opposite',
        docEntity: entity,
        opposite: pair.other,
        oppositionKind: pair.kind,
      };
      for (const section of pair.sections) {
        if (push(section, reason)) return related;
      }
      const mentions = [...(graph.postingsOf.get(pair.other) ?? [])].sort((x, y) => y[1] - x[1]);
      for (const [section] of mentions.slice(0, 2)) {
        if (push(section, reason)) return related;
      }
    }
  }

  // 3. Aspect facts (SEARCH-65): the sections stating an aspect of this
  // document's entities — "Aligned Delegate — voting responsibility".
  for (const { entity } of docEntities) {
    for (const aspect of graph.aspectsOf.get(entity) ?? []) {
      if (push(aspect.section, { kind: 'aspect', entity, wording: aspect.wording })) return related;
    }
  }

  // 4. Typed-edge evidence sections for those entities, either direction.
  for (const { entity } of docEntities) {
    for (const edge of graph.typedFrom.get(entity) ?? []) {
      for (const section of edge.sections) {
        if (push(section, { kind: 'typed-edge', subject: entity, relation: edge.r, object: edge.o })) return related;
      }
    }
    for (const edge of graph.typedTo.get(entity) ?? []) {
      for (const section of edge.sections) {
        if (push(section, { kind: 'typed-edge', subject: edge.s, relation: edge.r, object: entity })) return related;
      }
    }
  }

  // 5. Shared informative entities: score every co-mentioning document.
  const shared = new Map<string, { score: number; entities: string[] }>();
  for (const { entity, weight } of docEntities) {
    for (const [other, count] of graph.postingsOf.get(entity) ?? []) {
      if (seen.has(other)) continue;
      const entry = shared.get(other) ?? { score: 0, entities: [] };
      entry.score += weight * Math.log2(1 + count);
      entry.entities.push(entity);
      shared.set(other, entry);
    }
  }
  const ranked = [...shared.entries()].sort(
    (a, b) => b[1].entities.length - a[1].entities.length || b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1),
  );
  for (const [candidate, entry] of ranked) {
    // A single shared entity is weak evidence unless it is the doc's top entity;
    // require either two shared entities or the most informative one.
    if (entry.entities.length < 2 && entry.entities[0] !== docEntities[0]?.entity) continue;
    if (push(candidate, { kind: 'shared-entities', entities: entry.entities.slice(0, REASON_ENTITY_NAMES) })) {
      return related;
    }
  }
  return related;
}

/** The reason as a short display line. */
export function describeReason(reason: RelatedReason, graph: AtlasGraph): string {
  switch (reason.kind) {
    case 'cites':
      return 'cited by this document';
    case 'cited-by':
      return 'cites this document';
    case 'aspect':
      return `${entityDisplayName(reason.entity, graph)} — ${reason.wording}`;
    case 'opposite':
      return `about ${entityDisplayName(reason.opposite, graph)}, the ${
        reason.oppositionKind === 'failure' ? 'failure mode' : 'opposite'
      } of ${entityDisplayName(reason.docEntity, graph)}`;
    case 'typed-edge':
      return `${entityDisplayName(reason.subject, graph)} ${reason.relation.replace(/_/g, ' ')} ${entityDisplayName(reason.object, graph)}`;
    case 'shared-entities':
      return `shares: ${reason.entities.map((entity) => entityDisplayName(entity, graph)).join(', ')}`;
  }
}
