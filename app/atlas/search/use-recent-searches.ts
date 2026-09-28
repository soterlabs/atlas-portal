'use client';

import { useCallback, useState } from 'react';

export const RECENT_SEARCHES_KEY = 'atlas-search-recents';
export const MAX_RECENT_SEARCHES = 5;

function readRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT_SEARCHES);
  } catch {
    // Storage blocked, or corrupt contents: the feature is simply absent.
    return [];
  }
}

function writeRecents(recents: string[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recents));
  } catch {
    // Quota or private mode: keep the in-memory list, drop persistence.
  }
}

export interface UseRecentSearchesResult {
  recents: string[];
  /** Records a query that produced a navigation. Blank input is ignored. */
  remember: (query: string) => void;
}

/**
 * Last few submitted searches, newest first.
 *
 * Read lazily on first render rather than in an effect: HeroUI renders no modal
 * content while the modal is closed, so there is no server-rendered recents list
 * for a client-side read to mismatch against (spec §9).
 */
export function useRecentSearches(): UseRecentSearchesResult {
  const [recents, setRecents] = useState<string[]>(readRecents);

  const remember = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setRecents((current) => {
      const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, MAX_RECENT_SEARCHES);
      writeRecents(next);
      return next;
    });
  }, []);

  return { recents, remember };
}
