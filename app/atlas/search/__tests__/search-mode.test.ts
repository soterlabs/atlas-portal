import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredSearchMode, defaultSearchMode } from '../search-mode';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('SEARCH-20 mode selection', () => {
  it('honours the explicit deployment setting before the legacy server-embedder switch', () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'low-memory');
    expect(configuredSearchMode()).toBe('low-memory');

    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'local');
    expect(configuredSearchMode()).toBe('local');

    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'auto');
    vi.stubEnv('NEXT_PUBLIC_SEARCH_EMBEDDER', 'server');
    expect(configuredSearchMode()).toBe('auto');

    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'invalid');
    expect(configuredSearchMode()).toBe('low-memory');
  });

  it('uses low-memory mode by default on a constrained device', () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'auto');
    vi.stubEnv('NEXT_PUBLIC_SEARCH_EMBEDDER', '');
    vi.stubGlobal('navigator', { deviceMemory: 2, connection: { saveData: false } });
    expect(defaultSearchMode()).toBe('low-memory');
    vi.unstubAllGlobals();
  });

  it('uses full mode on a roomy device — there is no user override (SEARCH-80)', () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'auto');
    vi.stubEnv('NEXT_PUBLIC_SEARCH_EMBEDDER', '');
    vi.stubGlobal('navigator', { deviceMemory: 16, connection: { saveData: false } });
    // A stale pre-SEARCH-80 preference in storage must not matter.
    window.localStorage.setItem('atlas-search-mode', 'low-memory');
    expect(defaultSearchMode()).toBe('local');
    vi.unstubAllGlobals();
  });
});
