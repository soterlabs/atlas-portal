// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseQueryRewriteRequest } from '@/app/shared/search-query-rewrite';
import { AnthropicQueryRewriteProvider, QueryRewriteProviderError, estimateOpus5Cost } from '../provider';

const OUTPUT = {
  terms: ['maximum exposure', 'exposure tolerance'],
  filters: { types: [], scopes: [] },
  boolean: { must: [], should: [] },
};

describe('AnthropicQueryRewriteProvider', () => {
  it('requests Opus 5 adaptive thinking, effort, and a structured output schema', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        type: 'message',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: JSON.stringify(OUTPUT) },
        ],
        usage: { input_tokens: 300, output_tokens: 50 },
      }),
    );
    const provider = new AnthropicQueryRewriteProvider({ apiKey: 'server-secret', fetch: fetchMock });
    const result = await provider.rewrite(parseQueryRewriteRequest({ query: 'risk cap', effort: 'high' }));

    expect(result.output).toEqual(OUTPUT);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50, estimatedUsd: 0.00275 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('server-secret');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
    expect(JSON.stringify(body)).not.toContain('server-secret');
  });

  it('never exposes an upstream body in its error', async () => {
    const provider = new AnthropicQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () => new Response('echoed private query and secret', { status: 500 })),
    });
    await expect(provider.rewrite(parseQueryRewriteRequest({ query: 'private question' }))).rejects.toMatchObject({
      kind: 'upstream',
      message: 'Anthropic returned HTTP 500',
    });
  });

  it('classifies timeouts before headers and while consuming the response body', async () => {
    const hanging = new AnthropicQueryRewriteProvider({
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

    const stalledBody = new AnthropicQueryRewriteProvider({
      apiKey: 'secret',
      timeoutMs: 1,
      fetch: vi.fn(async (_url, init) => {
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        init?.signal?.addEventListener('abort', () =>
          streamController.error(new DOMException('aborted', 'AbortError')),
        );
        return new Response(stream, { headers: { 'content-type': 'application/json' } });
      }),
    });
    await expect(stalledBody.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('rejects invalid, incomplete, or unmetered upstream responses', async () => {
    const invalid = new AnthropicQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () =>
        Response.json({
          type: 'message',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'not-json' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ),
    });
    await expect(invalid.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toBeInstanceOf(
      QueryRewriteProviderError,
    );

    const truncated = new AnthropicQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () =>
        Response.json({
          type: 'message',
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: JSON.stringify(OUTPUT) }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ),
    });
    await expect(truncated.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    const missingUsage = new AnthropicQueryRewriteProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () =>
        Response.json({
          type: 'message',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(OUTPUT) }],
        }),
      ),
    });
    await expect(missingUsage.rewrite(parseQueryRewriteRequest({ query: 'question' }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('records cost using pinned list-price inputs', () => {
    expect(estimateOpus5Cost(300, 50)).toBe(0.00275);
    expect(() => estimateOpus5Cost(-1, 50)).toThrow(RangeError);
    expect(() => new AnthropicQueryRewriteProvider({ apiKey: 'secret', timeoutMs: 0 })).toThrowError(
      QueryRewriteProviderError,
    );
  });
});
