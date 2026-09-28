// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseQueryRewriteRequest } from '@/app/shared/search-query-rewrite';
import { QueryRewriteCache } from '../cache';
import type { QueryRewriteProvider } from '../provider';
import { QueryRewriteOutputError, QueryRewriteService, validateRewriteOutput } from '../service';

const usage = { inputTokens: 10, outputTokens: 5, estimatedUsd: 0.000175 };
const output = {
  terms: ['Maximum Exposure', 'maximum exposure', 'Exposure Tolerance'],
  filters: { types: ['core', 'Invented Type'], scopes: ['GOVERNANCE SCOPE', 'Invented Scope'] },
  boolean: { must: [], should: [] },
};

describe('QueryRewriteService', () => {
  it('canonicalizes allow-listed filters and discards model inventions', () => {
    const request = parseQueryRewriteRequest({
      query: 'risk cap',
      availableScopes: ['Governance Scope'],
    });
    expect(validateRewriteOutput(output, request)).toEqual({
      terms: ['Maximum Exposure', 'Exposure Tolerance'],
      filters: { types: ['Core'], scopes: ['Governance Scope'] },
      boolean: { must: [], should: [] },
    });
  });

  it('caches case/spacing-equivalent queries without reusing incompatible variants', async () => {
    const provider: QueryRewriteProvider = { model: 'claude-opus-5', rewrite: vi.fn(async () => ({ output, usage })) };
    let now = 0;
    const service = new QueryRewriteService(provider, new QueryRewriteCache(), () => ++now);

    const first = await service.rewrite(
      parseQueryRewriteRequest({ query: '  Risk CAP ', availableScopes: ['Governance Scope'] }),
    );
    const second = await service.rewrite(
      parseQueryRewriteRequest({ query: 'risk   cap', availableScopes: ['Governance Scope'] }),
    );
    await service.rewrite(
      parseQueryRewriteRequest({ query: 'risk cap', context: 'none', availableScopes: ['Governance Scope'] }),
    );

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.originalQuery).toBe('risk cap');
    expect(provider.rewrite).toHaveBeenCalledTimes(2);
  });

  it('rejects empty and malformed model output instead of searching nonsense', () => {
    const request = parseQueryRewriteRequest({ query: 'risk cap' });
    expect(() =>
      validateRewriteOutput(
        { terms: [], filters: { types: [], scopes: [] }, boolean: { must: [], should: [] } },
        request,
      ),
    ).toThrow('no search terms');
    expect(() => validateRewriteOutput({ terms: ['ok'] }, request)).toThrow('invalid shape');
    expect(() => validateRewriteOutput({ terms: ['ok'] }, request)).toThrowError(QueryRewriteOutputError);
  });

  it('rejects a syntactically valid rewrite that is too short for the search engine', async () => {
    const provider: QueryRewriteProvider = {
      model: 'claude-opus-5',
      rewrite: async () => ({
        output: { terms: ['x'], filters: { types: [], scopes: [] }, boolean: { must: [], should: [] } },
        usage,
      }),
    };
    await expect(
      new QueryRewriteService(provider).rewrite(parseQueryRewriteRequest({ query: 'find x' })),
    ).rejects.toThrow('too short to search safely');
  });

  it('requires must terms and suppresses filters in the boolean variant', () => {
    const request = parseQueryRewriteRequest({ query: 'risk cap', mode: 'boolean' });
    expect(() => validateRewriteOutput(output, request)).toThrow('no required terms');
    expect(
      validateRewriteOutput(
        {
          ...output,
          boolean: { must: ['maximum exposure'], should: ['risk limit'] },
        },
        request,
      ),
    ).toMatchObject({
      filters: { types: [], scopes: [] },
      boolean: { must: ['maximum exposure'], should: ['risk limit'] },
    });
  });

  it('rejects invalid provider usage metadata before it reaches a response or cache', async () => {
    const provider: QueryRewriteProvider = {
      model: 'claude-opus-5',
      rewrite: async () => ({ output, usage: { ...usage, inputTokens: 1.5 } }),
    };
    await expect(
      new QueryRewriteService(provider).rewrite(
        parseQueryRewriteRequest({ query: 'risk cap', availableScopes: ['Governance Scope'] }),
      ),
    ).rejects.toThrow('invalid usage metadata');
  });
});
