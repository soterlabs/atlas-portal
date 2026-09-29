/**
 * Shared contract for the answer feature (SEARCH-25): the browser's request to
 * `/api/search/answer` and the verified answer it gets back.
 *
 * Design: the client sends the query plus the document numbers of its own top results —
 * the shipped retrieval IS the client's list, so the server answers over exactly what
 * the reader is looking at. The server resolves those documents from its corpus, asks
 * the model for a quote-first structured answer, and then verifies every quote
 * byte-verbatim against the cited document before anything reaches the reader. An
 * answer that cannot be fully verified is not shown at all (fail closed).
 */

export const SEARCH_ANSWER_SCHEMA_VERSION = 1;

/** How many retrieved documents may be sent as context (the R8 matrix tops out at 20). */
export const MAX_ANSWER_CONTEXT_DOCS = 20;
export const MIN_ANSWER_CONTEXT_DOCS = 1;
export const MAX_ANSWER_QUERY_LENGTH = 300;

export interface SearchAnswerRequest {
  schemaVersion: typeof SEARCH_ANSWER_SCHEMA_VERSION;
  /** The reader's question, as typed. */
  query: string;
  /** Document numbers of the client's current top results, in rank order. */
  docNos: string[];
}

/** One verified claim: a statement, its verbatim supporting quote, and the source. */
export interface AnswerClaim {
  text: string;
  quote: string;
  docNo: string;
}

export interface SearchAnswerUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD at the provider's list price, recorded per the ticket. */
  estimatedCostUsd: number;
  latencyMs: number;
}

export type SearchAnswerResponse =
  | {
      schemaVersion: typeof SEARCH_ANSWER_SCHEMA_VERSION;
      kind: 'answer';
      claims: AnswerClaim[];
      usage: SearchAnswerUsage;
    }
  | {
      schemaVersion: typeof SEARCH_ANSWER_SCHEMA_VERSION;
      kind: 'abstained';
      /** The model's own words for why the documents do not answer the question. */
      reason: string;
      usage: SearchAnswerUsage;
    };

export class SearchAnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchAnswerValidationError';
  }
}

const DOC_NO_SHAPE = /^[A-Z][\w-]*(?:\.[\w-]+)+$/;

/** Parses and bounds an incoming request; throws SearchAnswerValidationError. */
export function parseSearchAnswerRequest(body: unknown): SearchAnswerRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SearchAnswerValidationError('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  if (record.schemaVersion !== SEARCH_ANSWER_SCHEMA_VERSION) {
    throw new SearchAnswerValidationError('unsupported schema version');
  }
  const query = typeof record.query === 'string' ? record.query.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!query || query.length > MAX_ANSWER_QUERY_LENGTH) {
    throw new SearchAnswerValidationError('query must be a non-empty string within the length bound');
  }
  if (!Array.isArray(record.docNos)) throw new SearchAnswerValidationError('docNos must be an array');
  const docNos: string[] = [];
  const seen = new Set<string>();
  for (const entry of record.docNos) {
    if (typeof entry !== 'string' || !DOC_NO_SHAPE.test(entry)) {
      throw new SearchAnswerValidationError('docNos must contain document numbers');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      docNos.push(entry);
    }
  }
  if (docNos.length < MIN_ANSWER_CONTEXT_DOCS || docNos.length > MAX_ANSWER_CONTEXT_DOCS) {
    throw new SearchAnswerValidationError(
      `docNos must hold between ${MIN_ANSWER_CONTEXT_DOCS} and ${MAX_ANSWER_CONTEXT_DOCS} entries`,
    );
  }
  return { schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION, query, docNos };
}
