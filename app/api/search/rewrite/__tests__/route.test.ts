// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryRewriteService } from '@/app/server/search-query-rewrite/service';
import { handleQueryRewrite } from '../route';

const output = {
  terms: ['aligned delegate', 'compensation'],
  filters: { types: [], scopes: [] },
  boolean: { must: [], should: [] },
};
const service = new QueryRewriteService({
  model: 'claude-opus-5',
  rewrite: vi.fn(async () => ({
    output,
    usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0.001 },
  })),
});
const allow = { check: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })) };

function request(body: string, headers: HeadersInit = {}): Request {
  const merged = new Headers({ 'content-type': 'application/json' });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Request('http://localhost/api/search/rewrite', { method: 'POST', body, headers: merged });
}

describe('query rewrite route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a validated rewrite without caching the HTTP response', async () => {
    const response = await handleQueryRewrite(request(JSON.stringify({ query: 'how are delegates paid' })), {
      enabled: true,
      apiKey: '',
      rateLimiter: allow,
      service,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ searchQuery: 'aligned delegate compensation' });
  });

  it('fails closed when disabled and rejects cross-site calls before spending quota', async () => {
    const disabled = await handleQueryRewrite(request('{}'), {
      enabled: false,
      apiKey: '',
      rateLimiter: allow,
    });
    expect(disabled.status).toBe(503);

    const crossSite = await handleQueryRewrite(request('{}', { 'sec-fetch-site': 'cross-site' }), {
      enabled: true,
      apiKey: 'secret',
      rateLimiter: allow,
    });
    expect(crossSite.status).toBe(403);
    expect(allow.check).not.toHaveBeenCalled();

    const crossOrigin = await handleQueryRewrite(
      request('{}', { origin: 'https://attacker.example', 'sec-fetch-site': 'same-site' }),
      { enabled: true, apiKey: 'secret', rateLimiter: allow },
    );
    expect(crossOrigin.status).toBe(403);
  });

  it('rejects invalid JSON, invalid contracts, oversized bodies, and rate excess', async () => {
    expect(
      (
        await handleQueryRewrite(request('{'), {
          enabled: true,
          apiKey: '',
          rateLimiter: allow,
          service,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handleQueryRewrite(request(JSON.stringify({ query: '' })), {
          enabled: true,
          apiKey: '',
          rateLimiter: allow,
          service,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handleQueryRewrite(request('{}', { 'content-length': '20000' }), {
          enabled: true,
          apiKey: '',
          rateLimiter: allow,
          service,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await handleQueryRewrite(request(JSON.stringify({ query: 'x'.repeat(20_000) })), {
          enabled: true,
          apiKey: '',
          rateLimiter: allow,
          service,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await handleQueryRewrite(request(JSON.stringify({ query: 'valid query' })), {
          enabled: true,
          apiKey: '',
          rateLimiter: { check: () => ({ allowed: false, retryAfterSeconds: 9 }) },
          service,
        })
      ).status,
    ).toBe(429);
  });

  it('requires JSON media and does not charge invalid requests against the limiter', async () => {
    const limiter = { check: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })) };
    const wrongMedia = new Request('http://localhost/api/search/rewrite', {
      method: 'POST',
      body: JSON.stringify({ query: 'valid query' }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(
      (
        await handleQueryRewrite(wrongMedia, {
          enabled: true,
          apiKey: '',
          rateLimiter: limiter,
          service,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await handleQueryRewrite(request(JSON.stringify({ query: '' })), {
          enabled: true,
          apiKey: '',
          rateLimiter: limiter,
          service,
        })
      ).status,
    ).toBe(400);
    expect(limiter.check).not.toHaveBeenCalled();
  });

  it('maps unusable model output to an upstream failure without leaking its details', async () => {
    const badService = new QueryRewriteService({
      model: 'claude-opus-5',
      rewrite: vi.fn(async () => ({
        output: { terms: [], filters: { types: [], scopes: [] }, boolean: { must: [], should: [] } },
        usage: { inputTokens: 10, outputTokens: 2, estimatedUsd: 0.0001 },
      })),
    });
    const response = await handleQueryRewrite(request(JSON.stringify({ query: 'valid question' })), {
      enabled: true,
      apiKey: '',
      rateLimiter: allow,
      service: badService,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Query rewrite returned unusable output' });
  });
});
