/**
 * SEARCH-55: browser loader for the committed abbreviation table. Separate from the
 * pure harvest module so `search-index` can import the harvest types without a
 * dependency cycle through `prebuilt-index`.
 */
import type { AbbreviationMeanings } from './abbreviations';
import { corpusHash } from './prebuilt-index';

export interface AbbreviationArtifact {
  /** v2 (SEARCH-83): entries carry a LIST of meanings; a v1 artifact is simply stale. */
  version: 2;
  /** SHA-256 of `JSON.stringify(scopeTrees)` at build time — same pin as every artifact. */
  corpusHash: string;
  entries: AbbreviationMeanings[];
}

export const ABBREVIATIONS_PATH = '/atlas-abbreviations.json';

/** The table for exactly this tree, or null (absent, stale, malformed — never throws). */
export async function tryLoadAbbreviations(scopeTrees: unknown): Promise<Map<string, AbbreviationMeanings> | null> {
  try {
    // Fetch and shape-check FIRST: an absent or malformed artifact must bail out
    // before touching WebCrypto (and before paying for the tree hash at all).
    const response = await fetch(ABBREVIATIONS_PATH);
    if (!response.ok) return null;
    const artifact = (await response.json()) as AbbreviationArtifact;
    if (artifact?.version !== 2 || typeof artifact.corpusHash !== 'string' || !Array.isArray(artifact.entries)) {
      return null;
    }
    const hash = await corpusHash(scopeTrees);
    if (!hash || artifact.corpusHash !== hash) return null;
    return new Map(artifact.entries.map((entry) => [entry.acronym, entry]));
  } catch {
    return null;
  }
}
