import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECENT_SEARCHES_KEY, useRecentSearches } from '../use-recent-searches';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useRecentSearches', () => {
  it('starts empty when storage has nothing', () => {
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents).toEqual([]);
  });

  it('loads previously stored queries', () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['voting', 'budget']));
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents).toEqual(['voting', 'budget']);
  });

  it('puts the newest query first and persists it', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.remember('voting'));
    act(() => result.current.remember('budget'));

    expect(result.current.recents).toEqual(['budget', 'voting']);
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['budget', 'voting']);
  });

  it('moves a repeated query to the front instead of duplicating it', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.remember('voting'));
    act(() => result.current.remember('budget'));
    act(() => result.current.remember('voting'));

    expect(result.current.recents).toEqual(['voting', 'budget']);
  });

  it('keeps at most five queries', () => {
    const { result } = renderHook(() => useRecentSearches());
    for (const query of ['a', 'b', 'c', 'd', 'e', 'f']) {
      act(() => result.current.remember(query));
    }
    expect(result.current.recents).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('ignores blank queries', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.remember('   '));
    expect(result.current.recents).toEqual([]);
  });

  it('stays silent when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents).toEqual([]);
  });

  it('stays silent when writing storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useRecentSearches());
    expect(() => act(() => result.current.remember('voting'))).not.toThrow();
    expect(result.current.recents).toEqual(['voting']);
  });

  it('recovers from corrupt stored data', () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, 'not json');
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents).toEqual([]);
  });
});
