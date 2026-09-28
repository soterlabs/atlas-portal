import { describe, expect, it } from 'vitest';
import {
  QueryRewriteValidationError,
  isQueryRewriteResponse,
  normalizeQuery,
  parseQueryRewriteRequest,
} from '../search-query-rewrite';

describe('query rewrite contract', () => {
  const validResponse = {
    schemaVersion: 1,
    originalQuery: 'delegate pay',
    normalizedQuery: 'delegate pay',
    searchQuery: 'aligned delegate compensation',
    rewrite: {
      terms: ['aligned delegate', 'compensation'],
      filters: { types: [], scopes: [] },
      boolean: { must: [], should: [] },
    },
    config: { mode: 'terms-and-filters', context: 'glossary-examples', effort: 'low' },
    model: 'claude-opus-5',
    cacheHit: false,
    latencyMs: 123,
    usage: { inputTokens: 300, outputTokens: 50, estimatedUsd: 0.00275 },
  };

  it('normalizes Unicode, case and whitespace for cache identity', () => {
    expect(normalizeQuery('  ＧＲＯＶＥ\n  Maximum   EXPOSURE ')).toBe('grove maximum exposure');
  });

  it('applies the production defaults while preserving display casing', () => {
    expect(parseQueryRewriteRequest({ query: '  Grove   limits ' })).toEqual({
      query: 'Grove limits',
      normalizedQuery: 'grove limits',
      mode: 'terms-and-filters',
      context: 'glossary-examples',
      effort: 'low',
      availableScopes: [],
    });
  });

  it.each([
    [{}, 'query must be a string'],
    [{ query: ' ' }, 'query must not be empty'],
    [{ query: 'ok', mode: 'magic' }, 'mode must be one of'],
    [{ query: 'ok', surprise: true }, 'unknown request field'],
    [{ query: `ok\u0000bad` }, 'control characters'],
    [{ query: 'x'.repeat(501) }, 'at most 500'],
    [{ query: 'ok', availableScopes: ['fine', 7] }, 'must contain strings'],
  ])('rejects malformed input %#', (value, message) => {
    expect(() => parseQueryRewriteRequest(value)).toThrowError(QueryRewriteValidationError);
    expect(() => parseQueryRewriteRequest(value)).toThrow(message);
  });

  it('checks response shape before the browser consumes it', () => {
    expect(isQueryRewriteResponse(validResponse)).toBe(true);
    expect(isQueryRewriteResponse({ schemaVersion: 1 })).toBe(false);
  });

  it.each([
    [{ ...validResponse, normalizedQuery: 'another query' }, 'mismatched normalized query'],
    [{ ...validResponse, searchQuery: 'different terms' }, 'mismatched search query'],
    [{ ...validResponse, latencyMs: Number.NaN }, 'non-finite latency'],
    [{ ...validResponse, usage: { ...validResponse.usage, inputTokens: -1 } }, 'negative token usage'],
    [
      {
        ...validResponse,
        rewrite: {
          ...validResponse.rewrite,
          filters: { types: ['Invented Type'], scopes: [] },
        },
      },
      'invented type',
    ],
    [
      {
        ...validResponse,
        rewrite: { ...validResponse.rewrite, terms: ['compensation', 'COMPENSATION'] },
        searchQuery: 'compensation COMPENSATION',
      },
      'duplicate terms',
    ],
  ])('rejects a success response with %s (%s)', (candidate) => {
    expect(isQueryRewriteResponse(candidate)).toBe(false);
  });
});
