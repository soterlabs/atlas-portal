/**
 * SEARCH-62: query interpretations from the knowledge graph — SEARCH-52's
 * confirm-the-variant design generalized from the tree lexicon (agents + scopes)
 * to the KG's 5,454 entities with aliases, acronym expansions, and typed edges.
 *
 * Two interpretation kinds, both deterministic, both mere SUGGESTIONS the user
 * confirms with a click (never a silent rewrite):
 *  - expansion: the query used an acronym/short form whose recorded expansion
 *    (`stands_for`) is a different surface — offer the spelled-out query;
 *  - opposite (SEARCH-64/DP-GR8): a query entity has a recorded opposite —
 *    offer it as a follow-up search, labeled as the opposite, never mixed in
 *    as a synonym;
 *  - relation: an entity-only query names a concept with typed edges — offer its
 *    top related targets ("cash stablecoins — Capital Ratio Requirement applies
 *    to") as follow-up searches.
 *
 * Guards: hyper-generic entities never produce chips (mention ceiling — the
 * SEARCH-60 lesson that frequent entities carry no direction), ambiguous surfaces
 * were already dropped at artifact build (the SEARCH-52 collision rule), and the
 * caller shows a chip only when its rewrite has matches (honest counts).
 */
import type { AtlasGraph } from './graph-artifact';
import { resolveQueryEntities } from './ranking/graph-route';
import { entityDisplayName } from './related-documents';

/** Entities mentioned more often than this are too generic to interpret anything. */
export const GENERIC_MENTION_CEILING = 1000;
/** Relation chips offered for an entity-only query. */
const RELATION_CHIP_CAP = 3;

export interface GraphInterpretation {
  kind: 'expansion' | 'opposite' | 'relation';
  /** Chip text without the count. */
  label: string;
  /** The full query the chip rewrites to on click. */
  rewrite: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The interpretations for one query. `query` is the raw visible query; rewrites
 * are built by replacing the matched surface inside it, so everything the user
 * typed around the entity survives the click.
 */
export function detectGraphInterpretations(query: string, graph: AtlasGraph): GraphInterpretation[] {
  const resolved = resolveQueryEntities(query, graph).filter((entity) => entity.mentions <= GENERIC_MENTION_CEILING);
  const interpretations: GraphInterpretation[] = [];

  // Expansion: the typed surface differs from the recorded spelled-out form.
  for (const entity of resolved) {
    const standsFor = graph.entity.get(entity.id)?.standsFor;
    if (!standsFor) continue;
    if (entity.surface === standsFor.toLowerCase()) continue;
    // Replace the matched surface in the original query, whitespace-tolerant and
    // case-insensitive; when the surface cannot be located verbatim (rare folding
    // differences), the interpretation is skipped rather than guessed.
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${entity.surface.split(' ').map(escapeRegExp).join('[\\s-]+')})(?![\\p{L}\\p{N}])`,
      'iu',
    );
    if (!pattern.test(query)) continue;
    const rewrite = query.replace(pattern, (_, before: string) => `${before}${standsFor}`).trim();
    interpretations.push({
      kind: 'expansion',
      label: `“${rewrite}”`,
      rewrite,
    });
  }

  // Opposites (SEARCH-64): any resolved entity with a recorded opposite offers
  // it — the relationship is opposition, so the label says so explicitly.
  for (const entity of resolved) {
    for (const pair of graph.oppositeOf.get(entity.id) ?? []) {
      const opposite = graph.entity.get(pair.other);
      if (!opposite || opposite.mentions > GENERIC_MENTION_CEILING) continue;
      const oppositeName = entityDisplayName(pair.other, graph);
      interpretations.push({
        kind: 'opposite',
        label: `“${oppositeName}” — the ${pair.kind === 'failure' ? 'failure mode' : 'opposite'} of ${entityDisplayName(entity.id, graph)}`,
        rewrite: oppositeName,
      });
    }
  }

  // Relations: only for an entity-only query — one resolved entity and no other
  // content besides its surface (entity+concept queries belong to the SEARCH-52
  // trio; offering relation detours there would nag).
  if (resolved.length === 1) {
    const entity = resolved[0];
    const residual = query
      .toLowerCase()
      .replace(new RegExp(entity.surface.split(' ').map(escapeRegExp).join('[\\s-]+'), 'iu'), ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (residual.length === 0) {
      const seen = new Set<string>();
      for (const edge of graph.typedFrom.get(entity.id) ?? []) {
        // SEARCH-65: with the judged closed vocabulary the only filter left is
        // the coarse related_to bucket (pre-canonical wordings pass unfiltered).
        if (edge.r === 'related_to') continue;
        const target = graph.entity.get(edge.o);
        if (!target || target.mentions > GENERIC_MENTION_CEILING) continue;
        if (seen.has(edge.o)) continue;
        seen.add(edge.o);
        const targetName = entityDisplayName(edge.o, graph);
        interpretations.push({
          kind: 'relation',
          label: `“${targetName}” — ${entityDisplayName(entity.id, graph)} ${edge.r.replace(/_/g, ' ')}`,
          rewrite: targetName,
        });
        if (seen.size >= RELATION_CHIP_CAP) break;
      }
    }
  }

  return interpretations;
}
