import type { AtlasDocumentType } from '@/app/server/atlas/atlas-types';
import { ATLAS_DOCUMENT_TYPES } from '@/app/server/atlas/constants';
import {
  MAX_REWRITE_FILTERS,
  MAX_REWRITE_TERMS,
  type ParsedQueryRewriteRequest,
  QUERY_REWRITE_SCHEMA_VERSION,
  type QueryRewriteOutput,
  type QueryRewriteResponse,
  type QueryRewriteUsage,
} from '@/app/shared/search-query-rewrite';
import { QueryRewriteCache } from './cache';
import type { ProviderRewriteResult, QueryRewriteProvider } from './provider';

interface CachedRewrite {
  rewrite: QueryRewriteOutput;
  searchQuery: string;
  usage: QueryRewriteUsage;
}

/** A structurally valid request whose upstream model result cannot be searched safely. */
export class QueryRewriteOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRewriteOutputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new QueryRewriteOutputError(`model output ${field} must be an array`);
  if (value.length > maxItems) throw new QueryRewriteOutputError(`model output ${field} has too many entries`);

  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new QueryRewriteOutputError(`model output ${field} must contain strings`);
    const clean = entry.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/u.test(clean)) {
      throw new QueryRewriteOutputError(`model output ${field} contains an invalid entry`);
    }
    const key = clean.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  }
  return result;
}

function canonicalTypes(values: string[]): AtlasDocumentType[] {
  const byFolded = new Map(ATLAS_DOCUMENT_TYPES.map((type) => [type.toLocaleLowerCase('en-US'), type]));
  return values
    .map((value) => byFolded.get(value.toLocaleLowerCase('en-US')))
    .filter((value): value is AtlasDocumentType => value !== undefined);
}

function canonicalScopes(values: string[], available: string[]): string[] {
  const byFolded = new Map(available.map((scope) => [scope.toLocaleLowerCase('en-US'), scope]));
  return values
    .map((value) => byFolded.get(value.toLocaleLowerCase('en-US')))
    .filter((value): value is string => value !== undefined);
}

export function validateRewriteOutput(value: unknown, request: ParsedQueryRewriteRequest): QueryRewriteOutput {
  if (!isRecord(value) || !isRecord(value.filters) || !isRecord(value.boolean)) {
    throw new QueryRewriteOutputError('model output has an invalid shape');
  }

  const terms = cleanList(value.terms, 'terms', MAX_REWRITE_TERMS, 80);
  const types = canonicalTypes(cleanList(value.filters.types, 'filters.types', MAX_REWRITE_FILTERS, 80));
  const scopes = canonicalScopes(
    cleanList(value.filters.scopes, 'filters.scopes', MAX_REWRITE_FILTERS, 100),
    request.availableScopes,
  );
  const must = cleanList(value.boolean.must, 'boolean.must', MAX_REWRITE_TERMS, 80);
  const should = cleanList(value.boolean.should, 'boolean.should', MAX_REWRITE_TERMS, 80);

  if (terms.length === 0) throw new QueryRewriteOutputError('model output contains no search terms');
  if (request.mode === 'boolean' && must.length === 0) {
    throw new QueryRewriteOutputError('boolean model output contains no required terms');
  }

  return {
    terms,
    filters: request.mode === 'terms-and-filters' ? { types, scopes } : { types: [], scopes: [] },
    boolean: request.mode === 'boolean' ? { must, should } : { must: [], should: [] },
  };
}

function cacheKey(request: ParsedQueryRewriteRequest): string {
  return JSON.stringify([
    request.normalizedQuery,
    request.mode,
    request.context,
    request.effort,
    [...request.availableScopes].map((scope) => scope.toLocaleLowerCase('en-US')).sort(),
  ]);
}

function makeCached(result: ProviderRewriteResult, request: ParsedQueryRewriteRequest): CachedRewrite {
  const rewrite = validateRewriteOutput(result.output, request);
  // The current keyword engine has AND semantics. The boolean experiment consumes the
  // full must/should structure offline; the browser's compact preview uses required
  // concepts, while the production default is terms-and-filters.
  const searchTerms = request.mode === 'boolean' ? rewrite.boolean.must : rewrite.terms;
  const searchQuery = searchTerms.join(' ');
  if (searchQuery.length < 3) throw new QueryRewriteOutputError('model output is too short to search safely');
  if (
    !Number.isSafeInteger(result.usage.inputTokens) ||
    result.usage.inputTokens < 0 ||
    !Number.isSafeInteger(result.usage.outputTokens) ||
    result.usage.outputTokens < 0 ||
    !Number.isFinite(result.usage.estimatedUsd) ||
    result.usage.estimatedUsd < 0
  ) {
    throw new QueryRewriteOutputError('model output contains invalid usage metadata');
  }
  return { rewrite, searchQuery, usage: result.usage };
}

export class QueryRewriteService {
  constructor(
    private readonly provider: QueryRewriteProvider,
    private readonly cache = new QueryRewriteCache<CachedRewrite>(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  async rewrite(request: ParsedQueryRewriteRequest): Promise<QueryRewriteResponse> {
    const started = this.now();
    const cached = await this.cache.getOrLoad(cacheKey(request), async () =>
      makeCached(await this.provider.rewrite(request), request),
    );

    return {
      schemaVersion: QUERY_REWRITE_SCHEMA_VERSION,
      originalQuery: request.query,
      normalizedQuery: request.normalizedQuery,
      searchQuery: cached.value.searchQuery,
      rewrite: cached.value.rewrite,
      config: { mode: request.mode, context: request.context, effort: request.effort },
      model: this.provider.model,
      cacheHit: cached.hit,
      latencyMs: Math.max(0, Math.round((this.now() - started) * 100) / 100),
      usage: cached.value.usage,
    };
  }
}
