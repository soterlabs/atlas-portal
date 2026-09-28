// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseQueryRewriteRequest } from '@/app/shared/search-query-rewrite';
import { OpenAiQueryRewriteProvider, estimateLunaCost } from '../openai-provider';

const OUTPUT = {
  terms: ['maximum exposure', 'exposure tolerance'],
  filters: { types: [], scopes: [] },
  boolean: { must: [], should: [] },
};

function completion(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(OUTPUT) } }],
    usage: { prompt_tokens: 300, completion_tokens: 50 },
    ...overrides,
  });
}

describe('OpenAiQueryRewriteProvider', () => {
  it('requests gpt-5.6-luna with reasoning effort and a strict structured-output schema', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => completion());
    const provider = new OpenAiQueryRewriteProvider({ apiKey: 'server-secret', fetch: fetchMock });
    const result = await provider.rewrite(parseQueryRewriteRequest({ query: 'risk cap', effort: 'high' }));

    expect(result.output).toEqual(OUTPUT);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50, estimatedUsd: estimateLunaCost(300, 50) });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer server-secret');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 16000, // generous: includes reasoning tokens on the gpt-5 family
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 'query_rewrite', strict: true } },
    });
    expect(JSON.stringify(body)).not.toContain('server-secret');
  });

  it('treats a starved completion (finish_reason length) as invalid, never parsing it', async () => {
    const provider = new OpenAiQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () => completion({ choices: [{ finish_reason: 'length', message: { content: '' } }] })),
    });
    await expect(provider.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('treats a refusal and an empty content as having no text output', async () => {
    const refusing = new OpenAiQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () =>
        completion({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] }),
      ),
    });
    await expect(refusing.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'invalid-response',
      message: 'OpenAI response has no text output',
    });
  });

  it('never exposes an upstream body in its error', async () => {
    const provider = new OpenAiQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () => new Response('echoed private query and secret', { status: 500 })),
    });
    await expect(provider.rewrite(parseQueryRewriteRequest({ query: 'private question' }))).rejects.toMatchObject({
      kind: 'upstream',
      message: 'OpenAI returned HTTP 500',
    });
  });

  it('classifies a pre-header timeout', async () => {
    const hanging = new OpenAiQueryRewriteProvider({
      apiKey: 'secret',
      timeoutMs: 1,
      fetch: vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    });
    await expect(hanging.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('rejects a blank api key at construction', () => {
    expect(() => new OpenAiQueryRewriteProvider({ apiKey: '  ' })).toThrow(/not configured/);
  });
});
