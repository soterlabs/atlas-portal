// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { QueryRewriteCache } from '../cache';

describe('QueryRewriteCache', () => {
  it('expires entries and evicts the least recently used entry', async () => {
    let now = 0;
    const cache = new QueryRewriteCache<number>({ maxEntries: 2, ttlMs: 10, now: () => now });
    const load = vi.fn(async (value: number) => value);

    expect(await cache.getOrLoad('a', () => load(1))).toEqual({ value: 1, hit: false });
    expect(await cache.getOrLoad('b', () => load(2))).toEqual({ value: 2, hit: false });
    expect(await cache.getOrLoad('a', () => load(9))).toEqual({ value: 1, hit: true });
    await cache.getOrLoad('c', () => load(3));
    expect(await cache.getOrLoad('b', () => load(4))).toEqual({ value: 4, hit: false });

    now = 20;
    expect(await cache.getOrLoad('a', () => load(5))).toEqual({ value: 5, hit: false });
  });

  it('coalesces concurrent loads and does not cache failures', async () => {
    const cache = new QueryRewriteCache<number>();
    let resolve!: (value: number) => void;
    const loader = vi.fn(() => new Promise<number>((done) => (resolve = done)));
    const first = cache.getOrLoad('same', loader);
    const second = cache.getOrLoad('same', loader);
    resolve(7);
    expect(await first).toEqual({ value: 7, hit: false });
    expect(await second).toEqual({ value: 7, hit: true });
    expect(loader).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error('bad');
    });
    await expect(cache.getOrLoad('failure', failing)).rejects.toThrow('bad');
    await expect(cache.getOrLoad('failure', failing)).rejects.toThrow('bad');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('does not let a cleared in-flight load repopulate or disrupt a newer load', async () => {
    const cache = new QueryRewriteCache<number>();
    let resolveOld!: (value: number) => void;
    let resolveFresh!: (value: number) => void;
    const old = cache.getOrLoad('same', () => new Promise<number>((resolve) => (resolveOld = resolve)));

    cache.clear();
    const fresh = cache.getOrLoad('same', () => new Promise<number>((resolve) => (resolveFresh = resolve)));
    resolveOld(1);
    expect(await old).toEqual({ value: 1, hit: false });

    const redundantLoader = vi.fn(async () => 3);
    const coalesced = cache.getOrLoad('same', redundantLoader);
    resolveFresh(2);
    expect(await fresh).toEqual({ value: 2, hit: false });
    expect(await coalesced).toEqual({ value: 2, hit: true });
    expect(redundantLoader).not.toHaveBeenCalled();
    expect(await cache.getOrLoad('same', redundantLoader)).toEqual({ value: 2, hit: true });
  });
});
