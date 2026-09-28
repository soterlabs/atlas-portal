/**
 * SEARCH-60: the GraphRAG retrieval route, as a ranking-library technique — pure
 * functions over the SEARCH-59 `AtlasGraph`, exercised by the offline harness only
 * until a measurement earns them a place in the engine (the SEARCH-40 rule).
 *
 * Three pieces:
 *  - `resolveQueryEntities`: folded, greedy longest-phrase alias resolution;
 *  - `graphCandidates`: entity-mention retrieval — coverage first (documents
 *    mentioning MORE of the query's entities outrank), informativeness-weighted
 *    (an entity mentioned 5,130 times says less than one mentioned 60 times),
 *    with optional one-hop expansion over typed relations;
 *  - `rerankWithinTiers`: the proximity re-rank arm — a stable reorder WITHIN each
 *    provenance block by `score · (1 + λ · normalizedGraphSignal)`, so tier
 *    membership and tier boundaries cannot change by construction.
 */
import { foldText } from '../fold';
import type { AtlasGraph } from '../graph-artifact';
import type { AtlasSearchHit } from '../search-index';

/** Longest alias phrase attempted during resolution, in tokens. */
const MAX_PHRASE_TOKENS = 5;

export interface ResolvedEntity {
  id: string;
  /** The folded query surface that matched. */
  surface: string;
  /** Corpus-wide mention count (informativeness denominator). */
  mentions: number;
  /** True when reached via a hop relation rather than the query text. */
  hopped: boolean;
}

/**
 * Resolves query text to graph entities: fold, tokenize, then greedy
 * longest-phrase matching against the alias map — "capital ratio requirement"
 * consumes all three tokens as one entity rather than resolving "capital" alone.
 */
export function resolveQueryEntities(query: string, graph: AtlasGraph): ResolvedEntity[] {
  const tokens = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
  const resolved = new Map<string, ResolvedEntity>();
  let index = 0;
  while (index < tokens.length) {
    let matched = 0;
    for (let span = Math.min(MAX_PHRASE_TOKENS, tokens.length - index); span >= 1; span -= 1) {
      const surface = tokens.slice(index, index + span).join(' ');
      const id = graph.aliasOf.get(surface);
      if (id !== undefined) {
        if (!resolved.has(id)) {
          resolved.set(id, { id, surface, mentions: graph.entity.get(id)?.mentions ?? 0, hopped: false });
        }
        matched = span;
        break;
      }
    }
    index += Math.max(1, matched);
  }
  return [...resolved.values()];
}

/** A frequent entity carries less signal per mention: 1/log2(2 + corpus mentions). */
const informativeness = (mentions: number): number => 1 / Math.log2(2 + mentions);

/** Discount applied to entities reached by a hop rather than the query text. */
const HOP_DISCOUNT = 0.5;

export interface GraphCandidate {
  docNo: string;
  score: number;
  /** Distinct non-hopped query entities mentioned by this document. */
  coverage: number;
  entities: string[];
}

export interface GraphCandidateOptions {
  limit?: number;
  /**
   * One-hop expansion: for each resolved entity E and relation r listed here, every
   * entity S with an edge (S, r, E) joins the set at HOP_DISCOUNT — `is_a_type_of`
   * pulls in E's subtypes (administrative_crr for crr).
   */
  hopRelations?: string[];
}

/**
 * Entity-mention retrieval. Ranking: coverage (distinct query entities in the
 * document) descending, then the informativeness-weighted mention score, then
 * doc_no for determinism. Returns [] when no entity resolves — the route stays
 * silent rather than guessing.
 */
export function graphCandidates(
  query: string,
  graph: AtlasGraph,
  options: GraphCandidateOptions = {},
): GraphCandidate[] {
  const limit = options.limit ?? 20;
  const entities = resolveQueryEntities(query, graph);
  if (entities.length === 0) return [];

  if (options.hopRelations?.length) {
    const relations = new Set(options.hopRelations);
    for (const entity of [...entities]) {
      for (const edge of graph.typedTo.get(entity.id) ?? []) {
        if (!relations.has(edge.r)) continue;
        if (entities.some((existing) => existing.id === edge.s)) continue;
        entities.push({
          id: edge.s,
          surface: entity.surface,
          mentions: graph.entity.get(edge.s)?.mentions ?? 0,
          hopped: true,
        });
      }
    }
  }

  const byDoc = new Map<string, { score: number; coverage: number; entities: string[] }>();
  for (const entity of entities) {
    const weight = informativeness(entity.mentions) * (entity.hopped ? HOP_DISCOUNT : 1);
    for (const [docNo, count] of graph.postingsOf.get(entity.id) ?? []) {
      const doc = byDoc.get(docNo) ?? { score: 0, coverage: 0, entities: [] };
      doc.score += weight * Math.log2(1 + count);
      if (!entity.hopped) doc.coverage += 1;
      doc.entities.push(entity.id);
      byDoc.set(docNo, doc);
    }
  }
  return [...byDoc.entries()]
    .map(([docNo, doc]) => ({ docNo, ...doc }))
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score || (a.docNo < b.docNo ? -1 : 1))
    .slice(0, limit);
}

/**
 * The Arm-B graph signal for one query: docNo → informativeness-weighted mention
 * score of the RESOLVED (non-hopped) entities. Zero for documents no query entity
 * mentions, and an always-zero function when nothing resolves.
 */
export function graphSignal(query: string, graph: AtlasGraph): (docNo: string) => number {
  const scores = new Map<string, number>();
  for (const entity of resolveQueryEntities(query, graph)) {
    const weight = informativeness(entity.mentions);
    for (const [docNo, count] of graph.postingsOf.get(entity.id) ?? []) {
      scores.set(docNo, (scores.get(docNo) ?? 0) + weight * Math.log2(1 + count));
    }
  }
  return (docNo) => scores.get(docNo) ?? 0;
}

/**
 * Stable within-tier re-rank: hits are split into CONTIGUOUS provenance blocks
 * (strict / rung / relaxed / expanded / undefined), each block reordered by
 * `score · (1 + λ · signal/maxSignalInBlock)` with a stable sort. Block borders,
 * membership, and hit objects are untouched; λ = 0 is the identity.
 */
export function rerankWithinTiers(
  hits: AtlasSearchHit[],
  docNoOf: (id: number) => string,
  signalOf: (docNo: string) => number,
  lambda: number,
): AtlasSearchHit[] {
  if (lambda === 0 || hits.length === 0) return hits;
  const result: AtlasSearchHit[] = [];
  let start = 0;
  while (start < hits.length) {
    let end = start + 1;
    while (end < hits.length && hits[end].provenance === hits[start].provenance) end += 1;
    const block = hits.slice(start, end);
    const signals = block.map((hit) => signalOf(docNoOf(hit.id)));
    const max = Math.max(...signals);
    if (max > 0) {
      const keyed = block.map((hit, offset) => ({ hit, key: hit.score * (1 + lambda * (signals[offset] / max)) }));
      keyed.sort((a, b) => b.key - a.key);
      result.push(...keyed.map((entry) => entry.hit));
    } else {
      result.push(...block);
    }
    start = end;
  }
  return result;
}
