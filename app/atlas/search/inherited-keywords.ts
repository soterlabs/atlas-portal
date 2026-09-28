/**
 * SEARCH-56: inherited ancestor keywords (measure-first).
 *
 * The tree's meaning is that every document narrows its ancestors, yet ancestor names
 * are invisible to the keyword tier (SEARCH-08: ancestry deliberately not indexed)
 * while visible to the dense tier (the breadcrumb is embedded). This module computes,
 * per document, a SMALL set of distinctive ancestor-title tokens to index in a
 * low-boost `inherited` field — so `crr grove` can be a true two-word match on the
 * Grove CRR documents.
 *
 * Selection is deterministic and corpus-derived. An ancestor-title token is inherited
 * only when it is DISTINCTIVE:
 *   - a member of the entity lexicon (agent/scope subtree roots, SEARCH-52), or
 *   - rare in the corpus's own text — document frequency at or below the threshold.
 * Generic title words (`governance`, `process`) fail the DF test and never transfer —
 * exactly the flooding SEARCH-08 guarded against. Tokens the document already
 * contains in its own text are skipped (inheritance would add nothing).
 *
 * Pure functions; nothing in the shipped path uses this until adoption.
 */
import type { EntityLexicon } from './entity-lexicon';
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { isStopword } from './stop-words';

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

function nameTokens(name: string): string[] {
  return foldText(name)
    .split(WORD_SEPARATOR)
    .filter((token) => token.length >= 3 && !isStopword(token));
}

/** Own-text document frequency per token (name + content + extras). */
export function computeDocumentFrequency(documents: readonly FlatAtlasDocument[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set(
      foldText(`${doc.name} ${doc.content} ${doc.extras ?? ''}`)
        .split(WORD_SEPARATOR)
        .filter((token) => token.length >= 3),
    );
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return df;
}

export interface InheritedOptions {
  /** Inherit a non-entity token only when its own-text DF is at or below this. */
  dfThreshold: number;
  entityLexicon: EntityLexicon;
  documentFrequency: Map<string, number>;
}

/**
 * The inherited keywords per document id: distinctive tokens from ancestor names,
 * deduplicated down the path, excluding tokens the document's own text already has.
 */
export function computeInheritedKeywords(
  documents: readonly FlatAtlasDocument[],
  options: InheritedOptions,
): Map<number, string[]> {
  const byId = new Map<number, FlatAtlasDocument>(documents.map((doc) => [doc.id, doc]));
  const distinctive = (token: string): boolean =>
    options.entityLexicon.byToken.has(token) || (options.documentFrequency.get(token) ?? 0) <= options.dfThreshold;

  // Distinctive tokens of each document's own NAME, cached — ancestors reuse it.
  const nameDistinctive = new Map<number, string[]>();
  const ownNameTokens = (doc: FlatAtlasDocument): string[] => {
    let tokens = nameDistinctive.get(doc.id);
    if (!tokens) {
      tokens = nameTokens(doc.name).filter(distinctive);
      nameDistinctive.set(doc.id, tokens);
    }
    return tokens;
  };

  const inherited = new Map<number, string[]>();
  for (const doc of documents) {
    const collected: string[] = [];
    const seen = new Set<string>();
    let parentId = doc.parentId;
    while (parentId !== null && parentId !== undefined) {
      const ancestor = byId.get(parentId);
      if (!ancestor) break;
      for (const token of ownNameTokens(ancestor)) {
        if (!seen.has(token)) {
          seen.add(token);
          collected.push(token);
        }
      }
      parentId = ancestor.parentId;
    }
    if (collected.length === 0) continue;
    const own = new Set(
      foldText(`${doc.name} ${doc.content} ${doc.extras ?? ''}`)
        .split(WORD_SEPARATOR)
        .filter(Boolean),
    );
    const fresh = collected.filter((token) => !own.has(token));
    if (fresh.length > 0) inherited.set(doc.id, fresh);
  }
  return inherited;
}
