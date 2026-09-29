import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryLoadGraph } from '../graph-artifact';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('tryLoadGraph when the build shipped no graph', () => {
  it('does not request /atlas-graph.json', async () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_GRAPH', '0');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(tryLoadGraph([])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still requests it when the build shipped one', async () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_GRAPH', '1');
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(tryLoadGraph([])).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/atlas-graph.json');
  });
});
