/**
 * SEARCH-52: the entity lexicon — Atlas agents and scopes, derived from the corpus
 * tree itself. Agents are the children of the "List Of Prime Agent Artifacts" node
 * (the same rule the markdown importer uses); scopes are the tree roots. Tokens come
 * from the entity names, minus stopwords and generic filler, with ambiguous tokens
 * (shared by two entities) dropped entirely.
 *
 * Deterministic and self-updating with the Atlas: no curation, no LLM, no model.
 * Pure functions — the modal builds the lexicon once per document tree.
 */
import { AGENT_ROOT_DOCUMENT_NAME } from '@/app/server/atlas/constants';
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { isStopword } from './stop-words';

export interface AtlasEntity {
  /** Flattened row id of the entity's subtree root. */
  id: number;
  docNo: string;
  name: string;
  kind: 'agent' | 'scope';
  /** The folded name token that identifies this entity in a query. */
  token: string;
}

export interface EntityLexicon {
  entities: AtlasEntity[];
  byToken: Map<string, AtlasEntity>;
}

/** Name filler that identifies nothing on its own. */
const GENERIC_NAME_TOKENS = new Set(['scope', 'scopes', 'atlas', 'sky']);

const NAME_SEPARATOR = /[^\p{L}\p{N}]+/u;

export function buildEntityLexicon(documents: FlatAtlasDocument[]): EntityLexicon {
  const agentRoot = documents.find((doc) => doc.name === AGENT_ROOT_DOCUMENT_NAME);
  const candidates: Array<{ doc: FlatAtlasDocument; kind: AtlasEntity['kind'] }> = [];
  for (const doc of documents) {
    if (doc.parentId === null) candidates.push({ doc, kind: 'scope' });
    else if (agentRoot && doc.parentId === agentRoot.id) candidates.push({ doc, kind: 'agent' });
  }

  // null marks a token claimed by two different entities: ambiguous, dropped.
  const claims = new Map<string, AtlasEntity | null>();
  for (const { doc, kind } of candidates) {
    const tokens = foldText(doc.name)
      .split(NAME_SEPARATOR)
      .filter((token) => token.length >= 3 && !isStopword(token) && !GENERIC_NAME_TOKENS.has(token));
    for (const token of tokens) {
      const existing = claims.get(token);
      if (existing === undefined) {
        claims.set(token, { id: doc.id, docNo: doc.doc_no, name: doc.name, kind, token });
      } else if (existing !== null && existing.id !== doc.id) {
        claims.set(token, null);
      }
    }
  }

  const byToken = new Map<string, AtlasEntity>();
  const entities: AtlasEntity[] = [];
  for (const [token, entity] of claims) {
    if (!entity) continue;
    byToken.set(token, entity);
    entities.push(entity);
  }
  return { entities, byToken };
}

export interface EntityQuery {
  entity: AtlasEntity;
  /** The query's non-entity content tokens, in order. */
  conceptTokens: string[];
}

/**
 * Detects an entity+concept query: exactly one entity among the tokens plus at least
 * one concept token. Two different entities, entity-only, or concept-only → null.
 * `tokens` should come from `tokenizeQueryUnstemmed` (folded, stopwords removed).
 */
export function detectEntityQuery(tokens: string[], lexicon: EntityLexicon): EntityQuery | null {
  let entity: AtlasEntity | null = null;
  const conceptTokens: string[] = [];
  for (const token of tokens) {
    const hit = lexicon.byToken.get(token);
    if (hit) {
      if (entity && entity.id !== hit.id) return null;
      entity = hit;
    } else {
      conceptTokens.push(token);
    }
  }
  return entity && conceptTokens.length > 0 ? { entity, conceptTokens } : null;
}
