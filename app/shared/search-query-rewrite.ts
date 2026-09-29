import type { AtlasDocumentType } from '@/app/server/atlas/atlas-types';
import { ATLAS_DOCUMENT_TYPES } from '@/app/server/atlas/constants';

export const QUERY_REWRITE_SCHEMA_VERSION = 1 as const;
/**
 * Models a rewrite response may report. OpenAI (`gpt-5.6-luna`) is the production
 * default per the licensing decision (2026-09-01); the Anthropic provider remains
 * available behind `QUERY_REWRITE_PROVIDER=anthropic`.
 */
export const QUERY_REWRITE_MODELS = ['claude-opus-5', 'gpt-5.6-luna'] as const;
export type QueryRewriteModelId = (typeof QUERY_REWRITE_MODELS)[number];
/** The Anthropic provider's model; kept under its historical name for old cache entries. */
export const QUERY_REWRITE_MODEL = 'claude-opus-5' as const;
export const MAX_QUERY_REWRITE_LENGTH = 500;
export const MAX_QUERY_REWRITE_SCOPES = 50;
export const MAX_REWRITE_TERMS = 12;
export const MAX_REWRITE_FILTERS = 8;

const MAX_REWRITE_TERM_LENGTH = 80;
const MAX_REWRITE_SCOPE_LENGTH = 100;

export const QUERY_REWRITE_MODES = ['terms', 'terms-and-filters', 'boolean'] as const;
export const QUERY_REWRITE_CONTEXTS = ['none', 'glossary', 'glossary-examples'] as const;
export const QUERY_REWRITE_EFFORTS = ['low', 'high'] as const;

export type QueryRewriteMode = (typeof QUERY_REWRITE_MODES)[number];
export type QueryRewriteContext = (typeof QUERY_REWRITE_CONTEXTS)[number];
export type QueryRewriteEffort = (typeof QUERY_REWRITE_EFFORTS)[number];

export interface QueryRewriteRequest {
  query: string;
  mode?: QueryRewriteMode;
  context?: QueryRewriteContext;
  effort?: QueryRewriteEffort;
  /** Scope names the caller can actually apply. Model-proposed values are intersected with this list. */
  availableScopes?: string[];
}

export interface ParsedQueryRewriteRequest {
  query: string;
  normalizedQuery: string;
  mode: QueryRewriteMode;
  context: QueryRewriteContext;
  effort: QueryRewriteEffort;
  availableScopes: string[];
}

export interface QueryRewriteOutput {
  terms: string[];
  filters: {
    types: AtlasDocumentType[];
    scopes: string[];
  };
  boolean: {
    must: string[];
    should: string[];
  };
}

export interface QueryRewriteUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface QueryRewriteResponse {
  schemaVersion: typeof QUERY_REWRITE_SCHEMA_VERSION;
  originalQuery: string;
  normalizedQuery: string;
  searchQuery: string;
  rewrite: QueryRewriteOutput;
  config: {
    mode: QueryRewriteMode;
    context: QueryRewriteContext;
    effort: QueryRewriteEffort;
  };
  model: QueryRewriteModelId;
  cacheHit: boolean;
  latencyMs: number;
  usage: QueryRewriteUsage;
}

export class QueryRewriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRewriteValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The cache identity is case/spacing/Unicode-normalised without changing the user's displayed words. */
export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new QueryRewriteValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function cleanScopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_QUERY_REWRITE_SCOPES) {
    throw new QueryRewriteValidationError(
      `availableScopes must be an array with at most ${MAX_QUERY_REWRITE_SCOPES} entries`,
    );
  }

  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new QueryRewriteValidationError('availableScopes must contain strings');
    const clean = entry.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 100 || /[\u0000-\u001f\u007f]/u.test(clean)) {
      throw new QueryRewriteValidationError('availableScopes contains an invalid scope name');
    }
    const key = clean.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      scopes.push(clean);
    }
  }
  return scopes;
}

export function parseQueryRewriteRequest(value: unknown): ParsedQueryRewriteRequest {
  if (!isRecord(value)) throw new QueryRewriteValidationError('request body must be a JSON object');

  const allowedKeys = new Set(['query', 'mode', 'context', 'effort', 'availableScopes']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new QueryRewriteValidationError(`unknown request field: ${unknownKeys[0]}`);
  }
  if (typeof value.query !== 'string') throw new QueryRewriteValidationError('query must be a string');

  const query = value.query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!query) throw new QueryRewriteValidationError('query must not be empty');
  if (query.length > MAX_QUERY_REWRITE_LENGTH) {
    throw new QueryRewriteValidationError(`query must be at most ${MAX_QUERY_REWRITE_LENGTH} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) {
    throw new QueryRewriteValidationError('query contains unsupported control characters');
  }

  return {
    query,
    normalizedQuery: normalizeQuery(query),
    mode: parseEnum(value.mode, QUERY_REWRITE_MODES, 'terms-and-filters', 'mode'),
    context: parseEnum(value.context, QUERY_REWRITE_CONTEXTS, 'glossary-examples', 'context'),
    effort: parseEnum(value.effort, QUERY_REWRITE_EFFORTS, 'low', 'effort'),
    availableScopes: cleanScopes(value.availableScopes),
  };
}

export function isQueryRewriteResponse(value: unknown): value is QueryRewriteResponse {
  if (!isRecord(value) || value.schemaVersion !== QUERY_REWRITE_SCHEMA_VERSION) return false;
  if (
    typeof value.originalQuery !== 'string' ||
    typeof value.normalizedQuery !== 'string' ||
    typeof value.searchQuery !== 'string' ||
    typeof value.cacheHit !== 'boolean' ||
    typeof value.latencyMs !== 'number' ||
    !QUERY_REWRITE_MODELS.includes(value.model as QueryRewriteModelId) ||
    !isRecord(value.rewrite) ||
    !isRecord(value.config) ||
    !isRecord(value.usage)
  ) {
    return false;
  }

  const cleanString = (candidate: unknown, maxLength: number): candidate is string =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= maxLength &&
    candidate === candidate.normalize('NFKC').trim().replace(/\s+/g, ' ') &&
    !/[\u0000-\u001f\u007f]/u.test(candidate);
  const cleanUniqueList = (candidate: unknown, maxItems: number, maxLength: number): candidate is string[] => {
    if (!Array.isArray(candidate) || candidate.length > maxItems) return false;
    const folded = new Set<string>();
    for (const entry of candidate) {
      if (!cleanString(entry, maxLength)) return false;
      folded.add(entry.toLocaleLowerCase('en-US'));
    }
    return folded.size === candidate.length;
  };

  if (
    !cleanString(value.originalQuery, MAX_QUERY_REWRITE_LENGTH) ||
    value.normalizedQuery !== normalizeQuery(value.originalQuery) ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0 ||
    !QUERY_REWRITE_MODES.includes(value.config.mode as QueryRewriteMode) ||
    !QUERY_REWRITE_CONTEXTS.includes(value.config.context as QueryRewriteContext) ||
    !QUERY_REWRITE_EFFORTS.includes(value.config.effort as QueryRewriteEffort) ||
    typeof value.usage.inputTokens !== 'number' ||
    !Number.isSafeInteger(value.usage.inputTokens) ||
    value.usage.inputTokens < 0 ||
    typeof value.usage.outputTokens !== 'number' ||
    !Number.isSafeInteger(value.usage.outputTokens) ||
    value.usage.outputTokens < 0 ||
    typeof value.usage.estimatedUsd !== 'number' ||
    !Number.isFinite(value.usage.estimatedUsd) ||
    value.usage.estimatedUsd < 0
  ) {
    return false;
  }

  const rewrite = value.rewrite;
  const filters = rewrite.filters;
  const boolean = rewrite.boolean;
  if (
    !cleanUniqueList(rewrite.terms, MAX_REWRITE_TERMS, MAX_REWRITE_TERM_LENGTH) ||
    rewrite.terms.length === 0 ||
    !isRecord(filters) ||
    !cleanUniqueList(filters.types, MAX_REWRITE_FILTERS, MAX_REWRITE_TERM_LENGTH) ||
    !filters.types.every((type) => ATLAS_DOCUMENT_TYPES.includes(type as AtlasDocumentType)) ||
    !cleanUniqueList(filters.scopes, MAX_REWRITE_FILTERS, MAX_REWRITE_SCOPE_LENGTH) ||
    !isRecord(boolean) ||
    !cleanUniqueList(boolean.must, MAX_REWRITE_TERMS, MAX_REWRITE_TERM_LENGTH) ||
    !cleanUniqueList(boolean.should, MAX_REWRITE_TERMS, MAX_REWRITE_TERM_LENGTH)
  ) {
    return false;
  }

  const mode = value.config.mode as QueryRewriteMode;
  if (
    (mode === 'terms' &&
      (filters.types.length > 0 ||
        filters.scopes.length > 0 ||
        boolean.must.length > 0 ||
        boolean.should.length > 0)) ||
    (mode === 'terms-and-filters' && (boolean.must.length > 0 || boolean.should.length > 0)) ||
    (mode === 'boolean' && (filters.types.length > 0 || filters.scopes.length > 0 || boolean.must.length === 0))
  ) {
    return false;
  }

  const expectedSearchQuery = (mode === 'boolean' ? boolean.must : rewrite.terms).join(' ');
  return value.searchQuery === expectedSearchQuery && value.searchQuery.length >= 3;
}
