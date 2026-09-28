import { describe, expect, it } from 'vitest';
import { QueryRewriteCache } from '@/app/server/search-query-rewrite/cache';
import {
  SEARCH_ANSWER_SCHEMA_VERSION,
  type SearchAnswerResponse,
  parseSearchAnswerRequest,
} from '@/app/shared/search-answer';
import type { AnswerContextDocument } from '../prompt';
import type { AnswerProvider, ProviderAnswerResult } from '../provider';
import { AnswerOutputError, SearchAnswerService } from '../service';

const DOC: AnswerContextDocument = {
  docNo: 'A.1',
  name: 'Maximum Exposure Tolerance',
  breadcrumb: ['Scope', 'Section'],
  text: 'Actual exposure may exceed that maximum by up to 5%, provided the excess is solely attributable to accrued interest.',
};

function fakeProvider(output: ProviderAnswerResult['output']): AnswerProvider {
  return {
    model: 'fake',
    answer: async () => ({ output, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }),
  };
}

function service(output: ProviderAnswerResult['output']): SearchAnswerService {
  return new SearchAnswerService({
    provider: fakeProvider(output),
    resolveDocument: async (docNo) => (docNo === 'A.1' ? DOC : undefined),
  });
}

const request = parseSearchAnswerRequest({
  schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION,
  query: 'what is the tolerance',
  docNos: ['A.1'],
});

describe('SearchAnswerService', () => {
  it('returns a verified answer', async () => {
    const { response } = await service({
      abstain: false,
      reason: '',
      claims: [
        {
          text: 'Excess up to 5% is allowed.',
          quote: 'may exceed that maximum by up to 5%, provided the excess',
          doc_no: 'A.1',
        },
      ],
    }).answer(request);
    expect(response.kind).toBe('answer');
    if (response.kind === 'answer') expect(response.claims[0].docNo).toBe('A.1');
  });

  it('fails closed when any quote does not verify', async () => {
    await expect(
      service({
        abstain: false,
        reason: '',
        claims: [
          { text: 'good', quote: 'may exceed that maximum by up to 5%, provided the excess', doc_no: 'A.1' },
          { text: 'fabricated', quote: 'a penalty of 10% applies immediately to the Prime', doc_no: 'A.1' },
        ],
      }).answer(request),
    ).rejects.toThrow(AnswerOutputError);
  });

  it('passes abstention through with the model reason', async () => {
    const { response } = await service({ abstain: true, reason: 'No penalty rule is present.', claims: [] }).answer(
      request,
    );
    expect(response.kind).toBe('abstained');
    if (response.kind === 'abstained') expect(response.reason).toMatch(/No penalty rule/);
  });

  it('rejects when no requested document exists in the corpus', async () => {
    const unknown = parseSearchAnswerRequest({
      schemaVersion: SEARCH_ANSWER_SCHEMA_VERSION,
      query: 'anything at all',
      docNos: ['B.9'],
    });
    await expect(service({ abstain: true, reason: '', claims: [] }).answer(unknown)).rejects.toThrow(AnswerOutputError);
  });

  it('does not share cached answers across context policies', async () => {
    let calls = 0;
    const counting: AnswerProvider = {
      model: 'fake',
      answer: async (_query, _documents, policy) => {
        calls += 1;
        return {
          output: { abstain: true, reason: `policy ${policy ?? 'full-document'}`, claims: [] },
          inputTokens: 1,
          outputTokens: 1,
          estimatedCostUsd: 0,
        };
      },
    };
    const cache = new QueryRewriteCache<SearchAnswerResponse>();
    const full = new SearchAnswerService({ provider: counting, resolveDocument: async () => DOC, cache });
    const snippet = new SearchAnswerService({
      provider: counting,
      resolveDocument: async () => DOC,
      cache,
      contextPolicy: 'bounded-snippet',
    });
    const first = await full.answer(request);
    const second = await snippet.answer(request);
    expect(calls).toBe(2);
    if (first.response.kind === 'abstained') expect(first.response.reason).toBe('policy full-document');
    if (second.response.kind === 'abstained') expect(second.response.reason).toBe('policy bounded-snippet');
  });

  it('caches by query + document list', async () => {
    let calls = 0;
    const counting: AnswerProvider = {
      model: 'fake',
      answer: async () => {
        calls += 1;
        return {
          output: { abstain: true, reason: 'x', claims: [] },
          inputTokens: 1,
          outputTokens: 1,
          estimatedCostUsd: 0,
        };
      },
    };
    const svc = new SearchAnswerService({ provider: counting, resolveDocument: async () => DOC });
    const first = await svc.answer(request);
    const second = await svc.answer(request);
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });
});

describe('parseSearchAnswerRequest', () => {
  it('bounds and canonicalises the request', () => {
    expect(() => parseSearchAnswerRequest({ schemaVersion: 1, query: '', docNos: ['A.1'] })).toThrow();
    expect(() => parseSearchAnswerRequest({ schemaVersion: 1, query: 'q', docNos: [] })).toThrow();
    expect(() => parseSearchAnswerRequest({ schemaVersion: 1, query: 'q', docNos: ['not a doc no!'] })).toThrow();
    expect(() => parseSearchAnswerRequest({ schemaVersion: 2, query: 'q', docNos: ['A.1'] })).toThrow();
    const parsed = parseSearchAnswerRequest({
      schemaVersion: 1,
      query: '  spaced   out ',
      docNos: ['A.1', 'A.1', 'A.2'],
    });
    expect(parsed.query).toBe('spaced out');
    expect(parsed.docNos).toEqual(['A.1', 'A.2']);
  });
});
