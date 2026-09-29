import {
  type ParsedQueryRewriteRequest,
  QUERY_REWRITE_MODEL,
  type QueryRewriteModelId,
  type QueryRewriteUsage,
} from '@/app/shared/search-query-rewrite';
import { QUERY_REWRITE_JSON_SCHEMA, buildQueryRewritePrompt } from './prompt';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_TOKENS = 4_096;

// Claude Opus 5 list pricing on 2026-08-31. Kept explicit so experiment reports are
// reproducible if list prices change later: $5/M input, $25/M output.
export const OPUS_5_INPUT_USD_PER_MILLION = 5;
export const OPUS_5_OUTPUT_USD_PER_MILLION = 25;

export interface ProviderRewriteResult {
  output: unknown;
  usage: QueryRewriteUsage;
}

export interface QueryRewriteProvider {
  /** The model this provider calls; reported in responses and part of cache identity. */
  readonly model: QueryRewriteModelId;
  rewrite(request: ParsedQueryRewriteRequest): Promise<ProviderRewriteResult>;
}

export class QueryRewriteProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'configuration' | 'timeout' | 'upstream' | 'invalid-response',
  ) {
    super(message);
    this.name = 'QueryRewriteProviderError';
  }
}

interface AnthropicProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTokenCount(usage: unknown, key: 'input_tokens' | 'output_tokens'): number {
  if (!isRecord(usage)) throw new QueryRewriteProviderError('Anthropic response has invalid usage', 'invalid-response');
  const value = usage[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new QueryRewriteProviderError('Anthropic response has invalid usage', 'invalid-response');
  }
  return value;
}

export function estimateOpus5Cost(inputTokens: number, outputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new RangeError('token counts must be finite and non-negative');
  }
  return (inputTokens * OPUS_5_INPUT_USD_PER_MILLION + outputTokens * OPUS_5_OUTPUT_USD_PER_MILLION) / 1_000_000;
}

export class AnthropicQueryRewriteProvider implements QueryRewriteProvider {
  readonly model: QueryRewriteModelId = QUERY_REWRITE_MODEL;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey.trim())
      throw new QueryRewriteProviderError('Anthropic API key is not configured', 'configuration');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new QueryRewriteProviderError('Anthropic timeout must be positive', 'configuration');
    }
  }

  async rewrite(request: ParsedQueryRewriteRequest): Promise<ProviderRewriteResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: QUERY_REWRITE_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: request.effort,
            format: { type: 'json_schema', schema: QUERY_REWRITE_JSON_SCHEMA },
          },
          messages: [{ role: 'user', content: buildQueryRewritePrompt(request) }],
        }),
      });

      if (!response.ok) {
        // Deliberately do not include the upstream response body: it can echo request data
        // or operational details and is not useful to the browser.
        throw new QueryRewriteProviderError(`Anthropic returned HTTP ${response.status}`, 'upstream');
      }

      let payload: unknown;
      try {
        // Keep the timeout armed until the complete body has been consumed. Fetch resolves
        // as soon as headers arrive, while an upstream can still stall indefinitely mid-body.
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new QueryRewriteProviderError('Query rewrite timed out', 'timeout');
        }
        throw new QueryRewriteProviderError('Anthropic returned non-JSON content', 'invalid-response');
      }
      if (
        !isRecord(payload) ||
        payload.type !== 'message' ||
        payload.stop_reason !== 'end_turn' ||
        !Array.isArray(payload.content)
      ) {
        throw new QueryRewriteProviderError('Anthropic response is incomplete', 'invalid-response');
      }
      const text = payload.content
        .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
        .map((block) => block.text)
        .filter((value): value is string => typeof value === 'string')
        .join('');
      if (!text) throw new QueryRewriteProviderError('Anthropic response has no text output', 'invalid-response');

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new QueryRewriteProviderError('Anthropic returned invalid structured output', 'invalid-response');
      }

      const inputTokens = readTokenCount(payload.usage, 'input_tokens');
      const outputTokens = readTokenCount(payload.usage, 'output_tokens');
      return {
        output,
        usage: {
          inputTokens,
          outputTokens,
          estimatedUsd: estimateOpus5Cost(inputTokens, outputTokens),
        },
      };
    } catch (error) {
      if (error instanceof QueryRewriteProviderError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new QueryRewriteProviderError('Query rewrite timed out', 'timeout');
      }
      throw new QueryRewriteProviderError('Anthropic request failed', 'upstream');
    } finally {
      clearTimeout(timeout);
    }
  }
}
