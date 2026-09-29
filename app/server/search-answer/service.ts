/**
 * The answer service (SEARCH-25): resolves the client's document numbers against the
 * corpus, asks the provider for a quote-first structured answer, verifies every quote
 * mechanically, and fails closed — an answer with a single unverifiable claim is never
 * returned as an answer.
 */
import { QueryRewriteCache } from '@/app/server/search-query-rewrite/cache';
import type { SearchAnswerRequest, SearchAnswerResponse, SearchAnswerUsage } from '@/app/shared/search-answer';
import { SEARCH_ANSWER_SCHEMA_VERSION } from '@/app/shared/search-answer';
import { type AnswerContextPolicy, DEFAULT_ANSWER_CONTEXT_POLICY } from './context-policy';
import type { AnswerContextDocument } from './prompt';
import type { AnswerProvider } from './provider';
import { allFaithful, verifyClaims } from './verify';

/** A structurally valid request the service cannot answer safely. */
export class AnswerOutputError extends Error {
  constructor(
    message: string,
    readonly reason: 'unknown-documents' | 'unverifiable-quote',
  ) {
    super(message);
    this.name = 'AnswerOutputError';
  }
}

export interface AnswerServiceOptions {
  provider: AnswerProvider;
  /** Resolves doc_no → context document, or undefined when absent from the corpus. */
  resolveDocument: (docNo: string) => Promise<AnswerContextDocument | undefined>;
  cache?: QueryRewriteCache<SearchAnswerResponse>;
  now?: () => number;
  /** How much of each document the model sees (SEARCH-47); default is the shipped full-document behaviour. */
  contextPolicy?: AnswerContextPolicy;
}

export class SearchAnswerService {
  private readonly provider: AnswerProvider;
  private readonly resolveDocument: AnswerServiceOptions['resolveDocument'];
  private readonly cache: QueryRewriteCache<SearchAnswerResponse>;
  private readonly now: () => number;
  private readonly contextPolicy: AnswerContextPolicy;

  constructor(options: AnswerServiceOptions) {
    this.provider = options.provider;
    this.resolveDocument = options.resolveDocument;
    this.cache = options.cache ?? new QueryRewriteCache<SearchAnswerResponse>();
    this.now = options.now ?? Date.now;
    this.contextPolicy = options.contextPolicy ?? DEFAULT_ANSWER_CONTEXT_POLICY;
  }

  async answer(request: SearchAnswerRequest): Promise<{ response: SearchAnswerResponse; cached: boolean }> {
    // The policy is in the key so a runtime policy change can never serve a stale mix.
    const key = `${this.contextPolicy}\u0000${request.query.toLocaleLowerCase('en-US')}\u0000${request.docNos.join(',')}`;
    let cached = true;
    const { value } = await this.cache.getOrLoad(key, async () => {
      cached = false;
      return this.answerUncached(request);
    });
    return { response: value, cached };
  }

  private async answerUncached(request: SearchAnswerRequest): Promise<SearchAnswerResponse> {
    const resolved = await Promise.all(request.docNos.map((docNo) => this.resolveDocument(docNo)));
    const documents = resolved.filter((doc): doc is AnswerContextDocument => doc !== undefined);
    if (documents.length === 0) {
      throw new AnswerOutputError('none of the requested documents exist in the corpus', 'unknown-documents');
    }

    const startedAt = this.now();
    const result = await this.provider.answer(request.query, documents, this.contextPolicy);
    const usage: SearchAnswerUsage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      latencyMs: this.now() - startedAt,
    };

    if (result.output.abstain) {
      return {
        schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION,
        kind: 'abstained',
        reason: result.output.reason || 'The provided documents do not answer this question.',
        usage,
      };
    }

    const textByDocNo = new Map(documents.map((doc) => [doc.docNo, `${doc.name}\n${doc.text}`]));
    const verifications = verifyClaims(
      result.output.claims.map((claim) => ({ text: claim.text, quote: claim.quote, docNo: claim.doc_no })),
      textByDocNo,
    );
    if (!allFaithful(verifications)) {
      // Fail closed: the reader never sees a claim whose quote we could not verify.
      throw new AnswerOutputError(
        `answer rejected: ${verifications.filter((v) => !v.quoteVerbatim || !v.documentKnown).length} of ${verifications.length} claims failed verification`,
        'unverifiable-quote',
      );
    }

    return {
      schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION,
      kind: 'answer',
      claims: verifications.map((entry) => entry.claim),
      usage,
    };
  }
}
