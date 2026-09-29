/**
 * SEARCH-71: the "Related results" category — documents connected to what the
 * query names through the Atlas's own recorded structure, each row carrying its
 * reason in plain words. Population precedence (strongest first): direct
 * answers (entity + relation words both matched), explicit citations of the
 * entity's sections, recorded facts, opposites, then mention-based connections.
 *
 * The adjustable quality number: `strength` = the share of the query's words
 * consumed by the matched entity surface plus matched relation words. Rows
 * below RELATED_STRENGTH_FLOOR are dropped from the section (SEARCH-74) and
 * never claim a document away from Similar or Partial. Display layer only;
 * ranking untouched; no mechanism terms reach the UI.
 */
import { queryStems } from './exactness';
import { foldText } from './fold';
import { answerTripleQuery } from './graph-answers';
import type { AtlasGraph } from './graph-artifact';
import { resolveQueryEntities } from './ranking/graph-route';
import { entityDisplayName } from './related-documents';
import { stemTerm } from './search-index';

/** Rows at or above this strength show; the rest sit behind the reveal. */
export const RELATED_STRENGTH_FLOOR = 0.66;
/** Hyper-generic entities relate to everything, hence to nothing. */
const GENERIC_MENTION_CEILING = 1000;
/** Candidate rows handed to the section (display caps and reveal apply there). */
const RELATED_LIMIT = 20;
/** Mention/citation sources per entity, to keep reasons focused. */
const TOP_SECTIONS_PER_ENTITY = 3;

export type RelatedResultKind = 'answer' | 'citation' | 'fact' | 'opposite' | 'mention';
const KIND_ORDER: RelatedResultKind[] = ['answer', 'citation', 'fact', 'opposite', 'mention'];

export interface RelatedResult {
  docNo: string;
  /** The stated reason — a full sentence, ready to render. */
  reason: string;
  /** Query-word coverage of the matched connection, 0..1. */
  strength: number;
  kind: RelatedResultKind;
}

const surfaceStems = (surface: string): string[] =>
  foldText(surface)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2)
    .map((token) => stemTerm(token));

/**
 * The related rows for one query, deduplicated (strongest kind wins), excluding
 * `exclude` doc numbers (everything the result list already shows) and unknown
 * documents. Deterministic; empty when no entity resolves.
 */
export function relatedResults(
  query: string,
  graph: AtlasGraph,
  options: {
    docNameOf: (docNo: string) => string | null;
    exclude?: Set<string>;
    limit?: number;
  },
): RelatedResult[] {
  const resolved = resolveQueryEntities(query, graph).filter((entity) => entity.mentions <= GENERIC_MENTION_CEILING);
  if (resolved.length === 0) return [];
  const totalStems = new Set(queryStems(query));
  if (totalStems.size === 0) return [];
  const coverageOfSurface = (surface: string): number => {
    const covered = new Set(surfaceStems(surface).filter((stem) => totalStems.has(stem)));
    return covered.size / totalStems.size;
  };

  const exclude = options.exclude ?? new Set<string>();
  const limit = options.limit ?? RELATED_LIMIT;
  const byDoc = new Map<string, RelatedResult>();
  const add = (docNo: string, kind: RelatedResultKind, reason: string, strength: number) => {
    if (exclude.has(docNo) || options.docNameOf(docNo) === null) return;
    const existing = byDoc.get(docNo);
    if (existing) {
      const existingKind = KIND_ORDER.indexOf(existing.kind);
      const newKind = KIND_ORDER.indexOf(kind);
      // Kind precedence dominates; within a kind the stronger coverage wins.
      if (newKind > existingKind || (newKind === existingKind && strength <= existing.strength)) return;
    }
    byDoc.set(docNo, { docNo, kind, reason, strength: Math.min(1, strength) });
  };

  // 1. Direct answers: entity + relation words both matched — full coverage by
  // construction (the matcher requires every leftover word covered).
  const answer = answerTripleQuery(query, graph, (docNo) => options.docNameOf(docNo) !== null);
  if (answer) {
    for (const row of answer.rows) add(row.section, 'answer', row.label, 1);
  }

  for (const entity of resolved) {
    const entityName = entityDisplayName(entity.id, graph);
    const strength = coverageOfSurface(entity.surface);
    const topSections = [...(graph.postingsOf.get(entity.id) ?? [])]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_SECTIONS_PER_ENTITY);

    // 2. Explicit citations of the entity's sections.
    for (const [section] of topSections) {
      for (const citing of graph.citedBy.get(section) ?? []) {
        add(citing, 'citation', `This section cites “${options.docNameOf(section) ?? section}”.`, strength);
      }
    }

    // 3. Recorded facts: aspect sections and typed-edge evidence.
    for (const aspect of graph.aspectsOf.get(entity.id) ?? []) {
      add(
        aspect.section,
        'fact',
        `The related terms “${entityName}” and “${aspect.wording}” are connected in this section.`,
        strength,
      );
    }
    for (const edge of graph.typedFrom.get(entity.id) ?? []) {
      if (edge.r === 'related_to') continue;
      const relationWords = (edge.wording ?? edge.r).replace(/_/g, ' ');
      for (const section of edge.sections) {
        add(
          section,
          'fact',
          `The related terms “${entityName}” and “${entityDisplayName(edge.o, graph)}” are connected in this section (${entityName} ${relationWords} ${entityDisplayName(edge.o, graph)}).`,
          strength,
        );
      }
    }

    // 4. Opposites: the co-occurrence sections, then the opposite's top mentions.
    for (const pair of graph.oppositeOf.get(entity.id) ?? []) {
      const oppositeName = entityDisplayName(pair.other, graph);
      const kindWord = pair.kind === 'failure' ? 'failure mode' : 'opposite';
      const reason = `This section is about “${oppositeName}” — the ${kindWord} of “${entityName}”.`;
      for (const section of pair.sections) add(section, 'opposite', reason, strength);
      for (const [section] of [...(graph.postingsOf.get(pair.other) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
        add(section, 'opposite', reason, strength);
      }
    }

    // 5. Mention-based: the entity's most-mentioning sections.
    for (const [section, count] of topSections) {
      add(
        section,
        'mention',
        `This section mentions “${entityName}” ${count} time${count === 1 ? '' : 's'}.`,
        strength,
      );
    }
  }

  return [...byDoc.values()]
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        b.strength - a.strength ||
        (a.docNo < b.docNo ? -1 : 1),
    )
    .slice(0, limit);
}
