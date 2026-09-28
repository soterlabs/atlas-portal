import {
  MAX_ANSWER_CONTEXT_DOCS,
  SEARCH_ANSWER_SCHEMA_VERSION,
  type SearchAnswerResponse,
} from '@/app/shared/search-answer';

export class AnswerClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerClientError';
  }
}

function isAnswerResponse(payload: unknown): payload is SearchAnswerResponse {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== SEARCH_ANSWER_SCHEMA_VERSION) return false;
  if (record.kind === 'abstained') return typeof record.reason === 'string';
  if (record.kind !== 'answer' || !Array.isArray(record.claims)) return false;
  return record.claims.every(
    (claim) =>
      typeof claim === 'object' &&
      claim !== null &&
      typeof (claim as Record<string, unknown>).text === 'string' &&
      typeof (claim as Record<string, unknown>).quote === 'string' &&
      typeof (claim as Record<string, unknown>).docNo === 'string',
  );
}

/** Requests a verified, cited answer over the reader's current top results. */
export async function fetchAtlasAnswer(
  query: string,
  docNos: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchAnswerResponse> {
  let response: Response;
  try {
    response = await fetchImpl('/api/search/answer', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION,
        query,
        docNos: docNos.slice(0, MAX_ANSWER_CONTEXT_DOCS),
      }),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new AnswerClientError('Could not reach the answer service. Your results are unchanged.');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AnswerClientError('The answer service returned an invalid response.');
  }
  if (!response.ok) {
    const isNoVerifiable =
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>).error === 'no verifiable answer';
    throw new AnswerClientError(
      isNoVerifiable
        ? 'No verifiable answer could be produced from these documents — please read the results directly.'
        : 'The answer service is unavailable right now.',
    );
  }
  if (!isAnswerResponse(payload)) throw new AnswerClientError('The answer service returned an invalid response.');
  return payload;
}
