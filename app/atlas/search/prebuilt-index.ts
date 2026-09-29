/**
 * Loading the prebuilt search index (SEARCH-17).
 *
 * The build writes `public/atlas-search-index.json`: the serialised MiniSearch index plus
 * the SHA-256 of the document tree it was built from. The browser fetches it, hashes its
 * own tree the same way, and uses the artifact only on an exact match — result ids are
 * array positions into the flattened tree, so an index built from a different corpus
 * would silently point at the wrong documents. On any mismatch, fetch failure, or
 * missing WebCrypto, the caller falls back to the in-browser build (the pre-SEARCH-17
 * behaviour), which is always correct, merely slower and without expansions.
 */
import type MiniSearch from 'minisearch';
import type { FlatAtlasDocument } from './flatten-documents';
import { loadSerializedSearchIndex } from './search-index';

export const PREBUILT_INDEX_VERSION = 1;
export const PREBUILT_INDEX_PATH = '/atlas-search-index.json';

export interface PrebuiltIndexArtifact {
  version: typeof PREBUILT_INDEX_VERSION;
  /** SHA-256 hex of `JSON.stringify(scopeTrees)` at build time. */
  corpusHash: string;
  documentCount: number;
  /** How many documents carried an expansion when the index was built. */
  expandedCount: number;
  /** The MiniSearch index, serialised with `JSON.stringify(index)`. */
  index: string;
}

const corpusHashCache = new WeakMap<object, Promise<string | null>>();

/** First 12 hex chars, for log lines that must name both hashes (SEARCH-49). */
export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…` : 'unavailable';
}

/**
 * Staleness is silent by design in production (the fallback is correct, merely slower)
 * but must be LOUD for a developer, who is one rebuild command away from the fix.
 */
export function staleArtifactWarning(message: string): void {
  if (process.env.NODE_ENV === 'development') console.warn(message);
  else console.info(message);
}

/** SHA-256 hex of the tree as the build hashes it, or null where WebCrypto is absent. */
export async function corpusHash(scopeTrees: unknown): Promise<string | null> {
  const compute = async (): Promise<string | null> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(scopeTrees));
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  };

  if ((typeof scopeTrees !== 'object' && typeof scopeTrees !== 'function') || scopeTrees === null) return compute();
  let cached = corpusHashCache.get(scopeTrees);
  if (!cached) {
    cached = compute();
    corpusHashCache.set(scopeTrees, cached);
    // A transient WebCrypto failure must not permanently disable every hashed search
    // artifact for this tree identity. Successful hashes remain cached for its lifetime.
    void cached.catch(() => {
      if (corpusHashCache.get(scopeTrees) === cached) corpusHashCache.delete(scopeTrees);
    });
  }
  return cached;
}

/**
 * The prebuilt index for exactly this tree, or null when there is none to be had —
 * absent artifact, corpus mismatch (a newer tree than the last build), or any error.
 * Null always means "build locally"; it is never an error state.
 */
export async function tryLoadPrebuiltIndex(
  scopeTrees: unknown,
  path: string = PREBUILT_INDEX_PATH,
): Promise<MiniSearch<FlatAtlasDocument> | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const response = await fetch(path);
    if (!response.ok) return null;

    const artifact = (await response.json()) as Partial<PrebuiltIndexArtifact>;
    if (artifact.version !== PREBUILT_INDEX_VERSION || typeof artifact.index !== 'string') return null;

    const hash = await corpusHash(scopeTrees);
    if (!hash || hash !== artifact.corpusHash) {
      staleArtifactWarning(
        `[atlas-search] prebuilt index does not match this corpus (corpus ${shortHash(hash)}, artifact ${shortHash(artifact.corpusHash)}); building locally — run search:check-artifacts.`,
      );
      return null;
    }
    return loadSerializedSearchIndex(artifact.index);
  } catch {
    return null;
  }
}
