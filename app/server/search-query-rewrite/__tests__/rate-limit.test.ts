// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { QueryRewriteRateLimiter } from '../rate-limit';

describe('QueryRewriteRateLimiter', () => {
  it('enforces client and global limits, then resets', () => {
    let now = 0;
    const limiter = new QueryRewriteRateLimiter({ perClient: 2, global: 3, windowMs: 1_000, now: () => now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(false);
    now = 1_000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('reports the reset for the bucket that actually rejected the call', () => {
    let now = 0;
    const limiter = new QueryRewriteRateLimiter({ perClient: 10, global: 1, windowMs: 10_000, now: () => now });
    now = 5_000;
    expect(limiter.check('a').allowed).toBe(true);
    now = 6_000;
    expect(limiter.check('new-client')).toEqual({ allowed: false, retryAfterSeconds: 4 });
  });

  it('rejects nonsensical limits at construction time', () => {
    expect(() => new QueryRewriteRateLimiter({ perClient: 0 })).toThrow('perClient must be a positive integer');
    expect(() => new QueryRewriteRateLimiter({ windowMs: Number.POSITIVE_INFINITY })).toThrow(
      'windowMs must be a positive integer',
    );
  });

  it('bounds tracked identities even while the global bucket rejects them', () => {
    const limiter = new QueryRewriteRateLimiter({ perClient: 10, global: 1, maxClients: 2 });
    expect(limiter.check('allowed').allowed).toBe(true);
    for (let index = 0; index < 100; index += 1) {
      expect(limiter.check(`rejected-${index}`).allowed).toBe(false);
    }

    const tracked = (limiter as unknown as { clients: Map<string, unknown> }).clients;
    expect(tracked.size).toBe(2);
  });
});
