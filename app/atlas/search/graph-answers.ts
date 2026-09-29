/**
 * SEARCH-65: direct answers for triple-shaped queries — "aligned delegate
 * duties" is (aligned_delegate, has_duty, ?) said in plain words. The query's
 * entity resolves through the alias map; the leftover words are matched against
 * the DP-GR9 canonical relation vocabulary (names + member wordings, folded and
 * stemmed); when the entity actually has such facts, they come back as sections
 * to show, each with a label saying what the fact is.
 *
 * Silent by design whenever any step finds nothing: no resolved entity, no
 * leftover words, no matching relation, or no facts. The coarse `related_to`
 * bucket never matches. Deterministic, no model.
 */
import { foldText } from './fold';
import type { AtlasGraph } from './graph-artifact';
import { resolveQueryEntities } from './ranking/graph-route';
import { entityDisplayName } from './related-documents';
import { stemTerm } from './search-index';

/** Same ceiling as the suggestion chips: hyper-generic entities answer nothing. */
export const ANSWER_GENERIC_CEILING = 1000;
/** Rows shown per query. */
export const ANSWER_CAP = 6;

/** Words that carry no relation meaning on either side of the match. */
const AUX_WORDS = new Set([
  'has',
  'have',
  'is',
  'are',
  'was',
  'be',
  'been',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'by',
  'for',
  'with',
  'on',
  'and',
  'or',
  'what',
  'which',
  'who',
  'does',
  'do',
  'its',
]);

const contentStems = (text: string): string[] =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !AUX_WORDS.has(token))
    .map((token) => stemTerm(token));

// Relation-token index per graph, built once and cached (dies with the graph).
const matcherCache = new WeakMap<AtlasGraph, Array<{ name: string; stems: Set<string> }>>();
function relationIndex(graph: AtlasGraph): Array<{ name: string; stems: Set<string> }> {
  let index = matcherCache.get(graph);
  if (!index) {
    index = [];
    for (const relation of graph.relations) {
      if (relation.name === 'related_to') continue;
      const stems = new Set<string>();
      for (const wording of [relation.name.replace(/_/g, ' '), ...relation.members.map((m) => m.replace(/_/g, ' '))]) {
        for (const stem of contentStems(wording)) stems.add(stem);
      }
      if (stems.size > 0) index.push({ name: relation.name, stems });
    }
    matcherCache.set(graph, index);
  }
  return index;
}

/** Canonical relations whose vocabulary covers every leftover query word. */
export function matchRelations(residualStems: string[], graph: AtlasGraph): string[] {
  if (residualStems.length === 0) return [];
  return relationIndex(graph)
    .filter((relation) => residualStems.every((stem) => relation.stems.has(stem)))
    .map((relation) => relation.name);
}

export interface GraphAnswerRow {
  /** The section holding the fact — the row navigates here. */
  section: string;
  /** What the fact says — a full sentence naming both related terms. */
  label: string;
}

export interface GraphAnswer {
  entityId: string;
  entityName: string;
  /** The canonical relations the leftover words matched. */
  relations: string[];
  rows: GraphAnswerRow[];
}

/**
 * The direct answer for one query, or null. `isKnownDocNo` filters the fact
 * sections to the current corpus.
 */
export function answerTripleQuery(
  query: string,
  graph: AtlasGraph,
  isKnownDocNo: (docNo: string) => boolean = () => true,
): GraphAnswer | null {
  const resolved = resolveQueryEntities(query, graph).filter((entity) => entity.mentions <= ANSWER_GENERIC_CEILING);
  if (resolved.length === 0) return null;

  // The leftover words: the folded query minus every resolved surface.
  let residualText = foldText(query);
  for (const entity of resolved) residualText = residualText.replace(entity.surface, ' ');
  const residualStems = contentStems(residualText);

  for (const entity of resolved) {
    // The relation may hide inside ANOTHER resolved surface: the Atlas has a
    // `duty` entity, so in "aligned delegate duty" the word resolves as an
    // entity and leaves no residual — yet for the subject `aligned delegate`
    // it is the relation word. Offer the other surfaces alongside the residual.
    const relationStems = [
      ...residualStems,
      ...resolved.filter((other) => other.id !== entity.id).flatMap((other) => contentStems(other.surface)),
    ];
    if (relationStems.length === 0) continue;
    const relations = matchRelations(relationStems, graph);
    if (relations.length === 0) continue;
    const relationSet = new Set(relations);

    const factRowsFor = (entityId: string): GraphAnswerRow[] => {
      const entityName = entityDisplayName(entityId, graph);
      const rows: GraphAnswerRow[] = [];
      const seen = new Set<string>();
      const push = (section: string, label: string) => {
        if (seen.has(section) || !isKnownDocNo(section)) return;
        seen.add(section);
        rows.push({ section, label });
      };
      // Aspect facts first: the section IS the answer. Reasons are full
      // sentences (SEARCH-76 follow-up, the adopted template) — never bare
      // entity—relation notation.
      for (const aspect of graph.aspectsOf.get(entityId) ?? []) {
        if (!relationSet.has(aspect.canonical)) continue;
        push(
          aspect.section,
          `The related terms “${entityName}” and “${aspect.wording}” are connected in this section.`,
        );
        if (rows.length >= ANSWER_CAP) break;
      }
      // Then entity-entity facts, evidenced by their sections.
      if (rows.length < ANSWER_CAP) {
        for (const edge of graph.typedFrom.get(entityId) ?? []) {
          if (!relationSet.has(edge.r)) continue;
          const targetName = entityDisplayName(edge.o, graph);
          const relationWords = (edge.wording ?? edge.r).replace(/_/g, ' ');
          for (const section of edge.sections) {
            push(
              section,
              `The related terms “${entityName}” and “${targetName}” are connected in this section (${entityName} ${relationWords} ${targetName}).`,
            );
            if (rows.length >= ANSWER_CAP) break;
          }
          if (rows.length >= ANSWER_CAP) break;
        }
      }
      return rows;
    };

    const rows = factRowsFor(entity.id);
    if (rows.length > 0) {
      return { entityId: entity.id, entityName: entityDisplayName(entity.id, graph), relations, rows };
    }
    // SEARCH-76: no facts on the resolved entity for the matched relation —
    // try its VARIANTS: entities whose name contains the resolved words
    // ("Core Facilitator" ⊇ "facilitator"). Lexical and deterministic: the
    // recorded edge between such pairs can mean anything (here it is
    // `reviews`), so edges are NOT followed; the rows carry the variant's own
    // name, making the substitution visible, never silent.
    for (const variantId of variantEntityIds(graph, entity.surface, entity.id)) {
      const variantRows = factRowsFor(variantId);
      if (variantRows.length > 0) {
        return {
          entityId: variantId,
          entityName: entityDisplayName(variantId, graph),
          relations,
          rows: variantRows,
        };
      }
    }
  }
  return null;
}

/** Variants tried per resolved entity. */
const VARIANT_CAP = 4;

/**
 * Entities whose folded name contains the surface's words contiguously at stem
 * level — fewest extra words first, then most-mentioned. The generic ceiling
 * applies; the entity itself is excluded.
 */
function variantEntityIds(graph: AtlasGraph, surface: string, excludeId: string): string[] {
  const surfaceStems = contentStems(surface);
  if (surfaceStems.length === 0) return [];
  const candidates: Array<{ id: string; extraWords: number; mentions: number }> = [];
  for (const [id, meta] of graph.entity) {
    if (id === excludeId || meta.mentions > ANSWER_GENERIC_CEILING) continue;
    const nameStems = foldText(meta.name)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map(stemTerm);
    if (nameStems.length <= surfaceStems.length) continue;
    let found = false;
    for (let start = 0; start + surfaceStems.length <= nameStems.length && !found; start++) {
      found = surfaceStems.every((stem, offset) => nameStems[start + offset] === stem);
    }
    if (found) candidates.push({ id, extraWords: nameStems.length - surfaceStems.length, mentions: meta.mentions });
  }
  return candidates
    .sort((a, b) => a.extraWords - b.extraWords || b.mentions - a.mentions || (a.id < b.id ? -1 : 1))
    .slice(0, VARIANT_CAP)
    .map((candidate) => candidate.id);
}
