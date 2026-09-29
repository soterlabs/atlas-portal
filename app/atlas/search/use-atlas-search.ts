'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type MiniSearch from 'minisearch';
import type { AtlasDocumentType } from '@/app/server/atlas/atlas-types';
import type { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { tryLoadAbbreviations } from './abbreviation-artifact';
import type { AbbreviationEntry, AbbreviationMeanings } from './abbreviations';
import { QUERY_EMBEDDING_MODEL } from './embedding-model';
import { type FamilyMap, tryLoadFamilyMap } from './family-map';
import { type FlatAtlasDocument, flattenAtlasDocuments } from './flatten-documents';
import { type HybridDenseBackend, searchAtlasHybrid } from './hybrid-search';
import { tryLoadPrebuiltIndex } from './prebuilt-index';
import { LocalQueryEmbedder } from './query-embedder';
import {
  type AtlasSearchHit,
  type AtlasSearchOptions,
  type AtlasSearchResults,
  buildSearchIndex,
  searchAtlas,
  searchAtlasTiered,
} from './search-index';
import { type SearchMode, configuredSearchMode, defaultSearchMode } from './search-mode';
import { type SegmentGroupSummary, type SegmentationCapture, segmentCandidates, summarizeGroups } from './segmentation';
import { createServerDenseBackend } from './server-dense-backend';
import { type VectorStore, tryLoadVectorStore } from './vector-store';

const EMPTY_RESULTS: AtlasSearchResults = { hits: [], total: 0 };

/** Hybrid results plus the SEARCH-29 category groups over the returned ranking. */
export type UpgradedAtlasSearchResults = AtlasSearchResults & {
  /**
   * One entry per rendered category with grouped-away members: the id of the group's
   * first visible row, its structural label, and the hidden members for inline
   * expansion ("+N more similar results").
   */
  groups: SegmentGroupSummary<AtlasSearchHit>[];
};

/** An index together with the exact document array it was built from. */
interface BuiltIndex {
  documents: FlatAtlasDocument[];
  index: MiniSearch<FlatAtlasDocument>;
}

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

/** Defers work to idle time, falling back to a timeout where requestIdleCallback is absent. */
function scheduleIdle(callback: () => void): IdleHandle {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return { kind: 'idle', id: window.requestIdleCallback(callback, { timeout: 2000 }) };
  }
  return { kind: 'timeout', id: setTimeout(callback, 0) };
}

function cancelIdle(handle: IdleHandle): void {
  if (handle.kind === 'idle') {
    window.cancelIdleCallback?.(handle.id);
  } else {
    clearTimeout(handle.id);
  }
}

export interface UseAtlasSearchResult {
  /** False until the index has finished building. */
  ready: boolean;
  /** Flattened documents; result ids index into this array. */
  documents: FlatAtlasDocument[];
  /** Distinct types present in the corpus, sorted — drives the filter chips. */
  types: AtlasDocumentType[];
  /** Returns empty results until `ready` is true. */
  search: (query: string, options?: AtlasSearchOptions) => AtlasSearchResults;
  /**
   * SEARCH-52: the strict-tier match count (documents whose own text matches every
   * query word) — the honest number for the disambiguation chips. 0 until ready.
   */
  probeStrictCount: (query: string, options?: AtlasSearchOptions) => number;
  /**
   * The staged upgrade of the same query: the SEARCH-29 segmented ranking (with its
   * category groups) over either the hybrid list (thin strict pass — SEARCH-21's dense
   * rung) or the keyword list (confident strict pass — the stage runs dense-free).
   * Null whenever the keyword results should stand unstaged: the dense path failed or
   * its artifacts are absent on a rung query. Never throws. The vector store and the
   * embedding model are loaded lazily on the first call that actually needs them
   * (§9b: a keyword-only session never pays for either); segmentation's cosine layers
   * use the store only once some dense query has loaded it.
   */
  upgradeSearch: (query: string, options?: AtlasSearchOptions) => Promise<UpgradedAtlasSearchResults | null>;
  /**
   * The document's interchangeable duplicate-family members (SEARCH-22's adopted
   * collapse policy), for "also under: …" rendering. Empty until the family map has
   * loaded (it loads with the first dense upgrade) or when the document has none.
   */
  familyMembers: (docNo: string) => string[];
  /**
   * SEARCH-82: the committed abbreviation table's single-meaning entry for a
   * folded token ("ad" → aligned delegate), or null (unknown token, table not
   * loaded — or the acronym is multi-meaning, which the engine's silent
   * expansion deliberately ignores per SEARCH-83).
   */
  abbreviationOf: (token: string) => AbbreviationEntry | null;
  /** SEARCH-83: every recorded meaning of a folded token, for the two-capital surface. */
  abbreviationMeaningsOf: (token: string) => AbbreviationMeanings | null;
  /** Where dense retrieval runs. Low-memory mode keeps both model and vectors server-side. */
  searchMode: SearchMode;
  /** State of the most recent query that actually needed the dense rung. */
  denseStatus: 'idle' | 'loading' | 'available' | 'unavailable';
}

/**
 * Builds and owns the search index for a document tree.
 *
 * The build starts on idle time after mount and proceeds in chunks, so it never
 * blocks interaction. A query issued before the build finishes returns empty
 * results; when `ready` flips, the consumer re-renders and the query runs (spec §5).
 *
 * **`scopeTrees` must be referentially stable across renders.** The Atlas page holds
 * it in `useState`, which satisfies this. Passing a freshly built array on every
 * render would re-flatten the corpus and rebuild the index endlessly, and `ready`
 * would never become true (spec §5: "memoized per `scopeTrees` identity").
 */
export function useAtlasSearch(scopeTrees: ExportAtlasTreeDocument[]): UseAtlasSearchResult {
  const documents = useMemo(() => flattenAtlasDocuments(scopeTrees), [scopeTrees]);
  const [built, setBuilt] = useState<BuiltIndex | null>(null);
  // Keep the server/client initial render deterministic. Device detection is
  // applied immediately after hydration, before a reader can issue a search.
  // SEARCH-80: the mode is auto-detected only — no user override.
  const configuredMode = configuredSearchMode();
  const [searchMode, setSearchModeState] = useState<SearchMode>(
    configuredMode === 'low-memory' ? 'low-memory' : 'local',
  );
  const [denseStatus, setDenseStatus] = useState<'idle' | 'loading' | 'available' | 'unavailable'>('idle');
  const modeRef = useRef(searchMode);
  const denseAttemptRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // Detection runs once, after hydration and before any search can have
    // issued a dense request — so no dense state needs resetting here.
    const applyDetectedMode = () => {
      const next = defaultSearchMode();
      modeRef.current = next;
      setSearchModeState(next);
    };
    applyDetectedMode();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const handle = scheduleIdle(() => {
      void (async () => {
        // Prefer the prebuilt index shipped with the page (SEARCH-17): it carries the
        // expansion field and skips the in-browser build. Loaded only when its corpus
        // hash matches this exact tree; any mismatch or failure falls back to building
        // locally, which is always correct — ids are array positions either way.
        const prebuilt = await tryLoadPrebuiltIndex(scopeTrees);
        if (cancelled) return;
        if (prebuilt) {
          setBuilt({ documents, index: prebuilt });
          return;
        }
        const index = await buildSearchIndex(documents);
        if (!cancelled) setBuilt({ documents, index });
      })();
    });

    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }, [documents, scopeTrees]);

  // SEARCH-55: the corpus-derived abbreviation table, loaded once per tree. Null
  // (absent/stale artifact) means no expansion — never an error.
  const abbreviationsRef = useRef<{
    documents: FlatAtlasDocument[];
    table: Map<string, AbbreviationMeanings> | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void tryLoadAbbreviations(scopeTrees).then((table) => {
      if (!cancelled) abbreviationsRef.current = { documents, table };
    });
    return () => {
      cancelled = true;
    };
  }, [documents, scopeTrees]);
  // SEARCH-83: every recorded meaning, for the two-capital surface.
  const abbreviationMeaningsOf = useCallback(
    (token: string): AbbreviationMeanings | null =>
      abbreviationsRef.current?.documents === documents ? (abbreviationsRef.current.table?.get(token) ?? null) : null,
    [documents],
  );
  // The engine's silent in-query expansion keeps requiring a single meaning
  // (SEARCH-83): a multi-meaning acronym is invisible to it, so existing
  // ranking stays byte-identical.
  const abbreviationOf = useCallback(
    (token: string): AbbreviationEntry | null => {
      const meanings = abbreviationMeaningsOf(token);
      return meanings && meanings.phrases.length === 1
        ? { acronym: meanings.acronym, phrase: meanings.phrases[0], source: meanings.source }
        : null;
    },
    [abbreviationMeaningsOf],
  );

  // Derived rather than stored: an index built for a previous tree is not ready for
  // this one. This is why the effect never has to synchronously reset a `ready` flag.
  const ready = built?.documents === documents;

  const types = useMemo(
    () => Array.from(new Set(documents.map((doc) => doc.type))).sort() as AtlasDocumentType[],
    [documents],
  );

  const search = useCallback(
    (query: string, options?: AtlasSearchOptions): AtlasSearchResults => {
      if (!built || built.documents !== documents) return EMPTY_RESULTS;
      return searchAtlas(built.index, query, { abbreviationOf, ...options });
    },
    [built, documents, abbreviationOf],
  );

  const probeStrictCount = useCallback(
    (query: string, options?: AtlasSearchOptions): number => {
      if (!built || built.documents !== documents) return 0;
      // A large limit so the strict tier is not capped; the relaxed passes are not run
      // to their depth either way (they trigger only below the limit).
      return searchAtlasTiered(built.index, query, { ...options, limit: 10_000 }).strict.length;
    },
    [built, documents],
  );

  // The dense backend, loaded at most once per tree and only on demand — the provider
  // is handed to `searchAtlasHybrid`, which calls it only after the strict-pass gate
  // has decided the rung is needed. A store that does not match this exact tree (hash,
  // row count or model) resolves to null and the hybrid path stays silent.
  const denseRef = useRef<{
    documents: FlatAtlasDocument[];
    mode: SearchMode;
    backend: Promise<HybridDenseBackend | null>;
  } | null>(null);
  // The local vector store once some dense query has loaded it — peeked (never
  // force-loaded) by the segmentation stage for its cosine layers. Stays null in
  // low-memory mode and before the first rung query: name/parent grouping still runs.
  const loadedStoreRef = useRef<{ documents: FlatAtlasDocument[]; store: VectorStore } | null>(null);
  const denseProvider = useCallback((): Promise<HybridDenseBackend | null> => {
    if (!denseRef.current || denseRef.current.documents !== documents || denseRef.current.mode !== searchMode) {
      const entry: NonNullable<typeof denseRef.current> = {
        documents,
        mode: searchMode,
        backend: Promise.resolve(null),
      };
      const loading =
        searchMode === 'low-memory'
          ? createServerDenseBackend(scopeTrees, documents)
          : (async () => {
              const store = await tryLoadVectorStore(scopeTrees);
              if (!store || store.manifest.count !== documents.length) return null;
              if (store.manifest.model !== QUERY_EMBEDDING_MODEL.key) return null;
              loadedStoreRef.current = { documents, store };
              return { store, embedder: new LocalQueryEmbedder() };
            })();
      entry.backend = loading.catch(() => {
        // Do not pin a transient hash/runtime failure to this tree and mode forever.
        // Deterministic absence still resolves to null and remains cached as intended.
        if (denseRef.current === entry) denseRef.current = null;
        return null;
      });
      denseRef.current = entry;
    }
    return denseRef.current.backend;
  }, [documents, scopeTrees, searchMode]);

  // The duplicate-family map (SEARCH-22), loaded lazily with the first dense upgrade
  // and kept for synchronous "also under" rendering. Null (absent/stale artifact)
  // means search runs uncollapsed — never an error.
  const familyRef = useRef<{ documents: FlatAtlasDocument[]; map: Promise<FamilyMap | null> } | null>(null);
  const loadedFamilyMapRef = useRef<FamilyMap | null>(null);
  const familyProvider = useCallback((): Promise<FamilyMap | null> => {
    if (!familyRef.current || familyRef.current.documents !== documents) {
      loadedFamilyMapRef.current = null;
      familyRef.current = {
        documents,
        map: tryLoadFamilyMap(scopeTrees)
          .then((map) => {
            loadedFamilyMapRef.current = map;
            return map;
          })
          .catch(() => null),
      };
    }
    return familyRef.current.map;
  }, [documents, scopeTrees]);

  const familyMembers = useCallback(
    (docNo: string): string[] => loadedFamilyMapRef.current?.membersOf(docNo) ?? [],
    [],
  );

  const upgradeSearch = useCallback(
    async (query: string, options?: AtlasSearchOptions): Promise<UpgradedAtlasSearchResults | null> => {
      if (!built || built.documents !== documents) return null;
      const attempt = ++denseAttemptRef.current;
      setDenseStatus('idle');
      const started = performance.now();
      // SEARCH-22's family-distinct rung, active only when the family map matches this
      // corpus. The collapse it shipped with is subsumed by the SEARCH-29 segmentation
      // stage below (grouping instead of dropping — measured equivalent-or-better in
      // diversity-runs/29-segment-verdict.md).
      const familyMap = await familyProvider();
      const familyOf = familyMap ? (docNo: string) => familyMap.familyOf(docNo) : undefined;
      // SEARCH-29: the segmentation stage. Cosine layers only when a dense query has
      // already loaded the store (§9b — never force-loaded); the name and parent
      // layers are the designed graceful degradation without it.
      const store = loadedStoreRef.current?.documents === documents ? loadedStoreRef.current.store : null;
      const vectorCache = new Map<number, Float32Array | null>();
      const vectorOf = store
        ? (id: number): Float32Array | null => {
            let vector = vectorCache.get(id);
            if (vector === undefined) {
              vector = id >= 0 && id < store.manifest.count ? store.vector(id) : null;
              vectorCache.set(id, vector);
            }
            return vector;
          }
        : undefined;
      const docOf = (id: number) => ({
        docNo: documents[id].doc_no,
        name: documents[id].name,
        breadcrumb: documents[id].breadcrumb,
      });
      let groups: SegmentGroupSummary<AtlasSearchHit>[] = [];
      const results = await searchAtlasHybrid(built.index, documents, query, denseProvider, {
        abbreviationOf,
        ...options,
        select: (candidates) => {
          const capture: SegmentationCapture = { categories: [], allocation: [] };
          const permuted = segmentCandidates(
            candidates,
            // SEARCH-32: parentId switches the category former to the tree backbone
            // (induced-result-tree segments, adopted by measurement).
            { docOf, vectorOf, parentIdOf: (id) => documents[id]?.parentId ?? null },
            capture,
          );
          groups = summarizeGroups(candidates, capture);
          return permuted;
        },
        applySelectWithoutRung: true,
        rungFamilyOf: familyOf,
        onDenseState: (state) => {
          if (mountedRef.current && denseAttemptRef.current === attempt) setDenseStatus(state);
        },
      });
      // A performance entry per applied upgrade (includes lazy store/model loading on
      // the first one) — what the SEARCH-19/21 browser measurements read.
      if (results) {
        try {
          performance.measure('atlas-dense-upgrade', { start: started, end: performance.now() });
        } catch {
          // performance.measure options are unsupported somewhere exotic: measurement is optional.
        }
      }
      return results ? { ...results, groups } : null;
    },
    [built, documents, denseProvider, familyProvider, abbreviationOf],
  );

  return {
    ready,
    documents,
    types,
    search,
    probeStrictCount,
    upgradeSearch,
    familyMembers,
    abbreviationOf,
    abbreviationMeaningsOf,
    searchMode,
    denseStatus,
  };
}
