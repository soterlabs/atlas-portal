/**
 * The duplicate-family map (SEARCH-22 shipping): which documents are interchangeable
 * copies of the same content, per the SEARCH-16 census's embedding-cosine definition
 * (the adopted collapse policy's families). Built offline by
 * `scripts/build-search-families.ts` into `atlas-search-families.json` (~60 KB) and,
 * like every prebuilt artifact, used only when its corpus hash matches the tree the
 * page holds; any mismatch or failure returns null and search runs uncollapsed.
 */
import { corpusHash, shortHash, staleArtifactWarning } from './prebuilt-index';

export const FAMILY_MAP_VERSION = 1;
export const FAMILY_MAP_PATH = '/atlas-search-families.json';

export interface FamilyMapArtifact {
  version: typeof FAMILY_MAP_VERSION;
  /** SHA-256 hex of `JSON.stringify(scopeTrees)` at build time — same as the index. */
  corpusHash: string;
  /** The census definition the families came from, for the record. */
  definition: 'embedding-cosine';
  cosineThreshold: number;
  /** Sorted member doc numbers per family (families are disjoint). */
  families: string[][];
}

export class FamilyMap {
  private readonly familyIndexByDocNo = new Map<string, number>();

  constructor(readonly families: string[][]) {
    families.forEach((members, index) => {
      for (const docNo of members) this.familyIndexByDocNo.set(docNo, index);
    });
  }

  /** A shared id for family members; the document's own number otherwise. */
  familyOf(docNo: string): string {
    const index = this.familyIndexByDocNo.get(docNo);
    return index === undefined ? docNo : this.families[index][0];
  }

  /** The document's other family members ("also under: …"); empty when unfamilied. */
  membersOf(docNo: string): string[] {
    const index = this.familyIndexByDocNo.get(docNo);
    return index === undefined ? [] : this.families[index].filter((member) => member !== docNo);
  }
}

/**
 * The family map for exactly this tree, or null when there is none to be had — absent
 * artifact, corpus mismatch, or any error. Null always means "search runs
 * uncollapsed"; it is never an error state.
 */
export async function tryLoadFamilyMap(scopeTrees: unknown, path: string = FAMILY_MAP_PATH): Promise<FamilyMap | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const response = await fetch(path);
    if (!response.ok) return null;
    const artifact = (await response.json()) as Partial<FamilyMapArtifact>;
    if (
      artifact.version !== FAMILY_MAP_VERSION ||
      typeof artifact.corpusHash !== 'string' ||
      !Array.isArray(artifact.families)
    ) {
      return null;
    }
    const hash = await corpusHash(scopeTrees);
    if (!hash || hash !== artifact.corpusHash) {
      staleArtifactWarning(
        `[atlas-search] family map does not match this corpus (corpus ${shortHash(hash)}, artifact ${shortHash(artifact.corpusHash)}); collapse and family-aware rung selection disabled — run search:check-artifacts.`,
      );
      return null;
    }
    return new FamilyMap(artifact.families as string[][]);
  } catch {
    return null;
  }
}

/**
 * The adopted collapse policy as a selection stage: keep each family's
 * highest-ranked member, drop later members — freed slots refill from below the cut
 * by construction (the stage runs on the full candidate list, SEARCH-21's seam).
 */
export function collapseSelection(
  familyOf: (docNo: string) => string,
  docNoOf: (id: number) => string,
): <T extends { id: number }>(candidates: T[]) => T[] {
  return (candidates) => {
    const seen = new Set<string>();
    return candidates.filter((hit) => {
      const family = familyOf(docNoOf(hit.id));
      if (seen.has(family)) return false;
      seen.add(family);
      return true;
    });
  };
}
