/**
 * SEARCH-86: the loader parses once per corpus version — repeated calls with
 * unchanged markdown return the identical object, so downstream per-tree memos
 * (the answer route's context map) actually hit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearAtlasPortalDataCache, loadAtlasPortalData } from './load-atlas-portal-data';

const fetchMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('./load-atlas-tree-from-github', () => ({ fetchAtlasMarkdownContent: fetchMock }));

const MONOLITH_A = [
  '# A.0 - Governance Scope [Scope] <!-- UUID: -->',
  'The governance scope body.',
  '## A.0.1 - Article One [Article] <!-- UUID: -->',
  'The article body.',
  '',
].join('\n');
const MONOLITH_B = MONOLITH_A.replace('The article body.', 'A changed article body.');

beforeEach(() => {
  _clearAtlasPortalDataCache();
  fetchMock.mockReset();
});

describe('loadAtlasPortalData (SEARCH-86)', () => {
  it('returns the identical object for unchanged markdown — one parse per corpus version', async () => {
    fetchMock.mockResolvedValue(MONOLITH_A);
    const first = await loadAtlasPortalData();
    const second = await loadAtlasPortalData();
    expect(second).toBe(first);
    expect(second.exportScopeTrees).toBe(first.exportScopeTrees);
    expect(first.exportScopeTrees).toHaveLength(1);
  });

  it('re-parses when the markdown changes', async () => {
    fetchMock.mockResolvedValueOnce(MONOLITH_A).mockResolvedValueOnce(MONOLITH_B);
    const first = await loadAtlasPortalData();
    const second = await loadAtlasPortalData();
    expect(second).not.toBe(first);
    expect(second.exportScopeTrees).not.toBe(first.exportScopeTrees);
  });

  it('a broken parse still fails loudly and is not cached', async () => {
    // A title line the parser cannot place in the tree fails validation.
    fetchMock.mockResolvedValue('not an atlas monolith at all');
    await expect(loadAtlasPortalData()).rejects.toThrow(/validation FAILED/);
    // The failure was not cached: a good corpus afterwards parses fine.
    fetchMock.mockResolvedValue(MONOLITH_A);
    await expect(loadAtlasPortalData()).resolves.toBeTruthy();
  });
});
