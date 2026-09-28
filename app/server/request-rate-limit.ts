interface Bucket {
  count: number;
  resetsAt: number;
}

interface RateLimiterOptions {
  perClient?: number;
  global?: number;
  windowMs?: number;
  maxClients?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Bounded, process-local fixed-window guard for anonymous server work. It limits both
 * each observed client and the whole instance. A distributed platform limit is still
 * required when a deployment needs a global limit across multiple instances.
 */
export class RequestRateLimiter {
  private readonly clients = new Map<string, Bucket>();
  private globalBucket: Bucket;
  private readonly perClient: number;
  private readonly global: number;
  private readonly windowMs: number;
  private readonly maxClients: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions = {}) {
    this.perClient = options.perClient ?? 12;
    this.global = options.global ?? 120;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxClients = options.maxClients ?? 10_000;
    this.now = options.now ?? Date.now;
    for (const [name, value] of [
      ['perClient', this.perClient],
      ['global', this.global],
      ['windowMs', this.windowMs],
      ['maxClients', this.maxClients],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
    this.globalBucket = { count: 0, resetsAt: this.now() + this.windowMs };
  }

  check(client: string): RateLimitDecision {
    const now = this.now();
    if (this.globalBucket.resetsAt <= now) this.globalBucket = { count: 0, resetsAt: now + this.windowMs };

    let bucket = this.clients.get(client);
    if (!bucket || bucket.resetsAt <= now) {
      bucket = { count: 0, resetsAt: now + this.windowMs };
      this.clients.delete(client);
      this.clients.set(client, bucket);
    } else {
      // Refresh insertion order so the bounded map evicts the least-recently used key.
      this.clients.delete(client);
      this.clients.set(client, bucket);
    }
    // Enforce the memory bound even when the global bucket rejects every new spoofed
    // client; rejected identities must not be able to grow this map without limit.
    while (this.clients.size > this.maxClients) {
      const oldest = this.clients.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }

    const clientLimited = bucket.count >= this.perClient;
    const globallyLimited = this.globalBucket.count >= this.global;
    if (clientLimited || globallyLimited) {
      const retryAt = Math.max(clientLimited ? bucket.resetsAt : 0, globallyLimited ? this.globalBucket.resetsAt : 0);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)) };
    }

    bucket.count += 1;
    this.globalBucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
