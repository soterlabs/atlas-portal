import {
  type QueryRewriteRequest,
  type QueryRewriteResponse,
  isQueryRewriteResponse,
  normalizeQuery,
} from '@/app/shared/search-query-rewrite';

export class QueryRewriteClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRewriteClientError';
  }
}

export async function rewriteAtlasQuery(
  request: QueryRewriteRequest,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<QueryRewriteResponse> {
  let response: Response;
  try {
    response = await fetchImpl('/api/search/rewrite', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new QueryRewriteClientError('Could not reach query understanding. Your current search is unchanged.');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new QueryRewriteClientError('Query understanding returned an invalid response. Your search is unchanged.');
  }
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Query understanding is unavailable';
    throw new QueryRewriteClientError(`${message}. Your current search is unchanged.`);
  }
  if (!isQueryRewriteResponse(payload)) {
    throw new QueryRewriteClientError('Query understanding returned an invalid response. Your search is unchanged.');
  }
  if (
    payload.normalizedQuery !== normalizeQuery(request.query) ||
    payload.config.mode !== (request.mode ?? 'terms-and-filters') ||
    payload.config.context !== (request.context ?? 'glossary-examples') ||
    payload.config.effort !== (request.effort ?? 'low')
  ) {
    throw new QueryRewriteClientError('Query understanding returned a mismatched response. Your search is unchanged.');
  }
  return payload;
}
