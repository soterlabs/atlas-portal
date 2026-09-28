interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheLoadResult<T> {
  value: T;
  hit: boolean;
}

interface QueryRewriteCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Bounded process-local TTL/LRU cache with coalescing for simultaneous identical asks. */
export class QueryRewriteCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private generation = 0;

  constructor(options: QueryRewriteCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) throw new Error('maxEntries must be positive');
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('ttlMs must be positive');
  }

  async getOrLoad(key: string, load: () => Promise<T>): Promise<CacheLoadResult<T>> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      // Map insertion order is the LRU order.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { value: cached.value, hit: true };
    }
    if (cached) this.entries.delete(key);

    const running = this.inFlight.get(key);
    if (running) return { value: await running, hit: true };

    const generation = this.generation;
    const promise = load();
    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      if (generation === this.generation) {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
      }
      return { value, hit: false };
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
  }
}
