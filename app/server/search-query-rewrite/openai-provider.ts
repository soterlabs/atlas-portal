/**
 * OpenAI query-rewrite provider (SEARCH-23): the second implementation behind the
 * `QueryRewriteProvider` seam, added 2026-09-01 per the licensing decision — the org
 * holds an OpenAI license, so `gpt-5.6-luna` (the model already generating SEARCH-17's
 * expansions) is the production default; the Anthropic provider stays available.
 *
 * Conventions carried over from the expansion generator's hard-won lessons:
 * `max_completion_tokens` includes reasoning tokens on the gpt-5 family (1024 starved
 * completions empty; the cap is generous by decision), and `finish_reason: 'length'`
 * is treated as an invalid response, never silently parsed. The request's `effort`
 * experiment dimension maps to `reasoning_effort`. Structured output uses the same
 * JSON schema as the Anthropic side, in OpenAI strict mode; local semantic validation
 * still runs in the service.
 */
import {
  type ParsedQueryRewriteRequest,
  type QueryRewriteModelId,
  type QueryRewriteUsage,
} from '@/app/shared/search-query-rewrite';
import { QUERY_REWRITE_JSON_SCHEMA, buildQueryRewritePrompt } from './prompt';
import { type ProviderRewriteResult, type QueryRewriteProvider, QueryRewriteProviderError } from './provider';

const OPENAI_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 10_000;
// Includes reasoning tokens on gpt-5-family models — generous by decision ("use more
// tokens"): a starved cap yields finish_reason 'length' with empty content.
const MAX_COMPLETION_TOKENS = 16_000;

export const OPENAI_QUERY_REWRITE_MODEL: QueryRewriteModelId = 'gpt-5.6-luna';

// gpt-5.6-luna list pricing on 2026-09-01, explicit for reproducible experiment
// reports: $0.20/M input, $1.20/M output.
export const LUNA_INPUT_USD_PER_MILLION = 0.2;
export const LUNA_OUTPUT_USD_PER_MILLION = 1.2;

export function estimateLunaCost(inputTokens: number, outputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new RangeError('token counts must be finite and non-negative');
  }
  return (inputTokens * LUNA_INPUT_USD_PER_MILLION + outputTokens * LUNA_OUTPUT_USD_PER_MILLION) / 1_000_000;
}

interface OpenAiProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTokenCount(usage: unknown, key: 'prompt_tokens' | 'completion_tokens'): number {
  if (!isRecord(usage)) throw new QueryRewriteProviderError('OpenAI response has invalid usage', 'invalid-response');
  const value = usage[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new QueryRewriteProviderError('OpenAI response has invalid usage', 'invalid-response');
  }
  return value;
}

export class OpenAiQueryRewriteProvider implements QueryRewriteProvider {
  readonly model: QueryRewriteModelId = OPENAI_QUERY_REWRITE_MODEL;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiProviderOptions) {
    if (!options.apiKey.trim())
      throw new QueryRewriteProviderError('OpenAI API key is not configured', 'configuration');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new QueryRewriteProviderError('OpenAI timeout must be positive', 'configuration');
    }
  }

  async rewrite(request: ParsedQueryRewriteRequest): Promise<ProviderRewriteResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(OPENAI_COMPLETIONS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          reasoning_effort: request.effort,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'query_rewrite', strict: true, schema: QUERY_REWRITE_JSON_SCHEMA },
          },
          messages: [{ role: 'user', content: buildQueryRewritePrompt(request) }],
        }),
      });

      if (!response.ok) {
        // Deliberately no upstream body in the error: it can echo request data.
        throw new QueryRewriteProviderError(`OpenAI returned HTTP ${response.status}`, 'upstream');
      }

      let payload: unknown;
      try {
        // Keep the timeout armed until the complete body is consumed — fetch resolves on
        // headers while an upstream can stall mid-body.
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new QueryRewriteProviderError('Query rewrite timed out', 'timeout');
        }
        throw new QueryRewriteProviderError('OpenAI returned non-JSON content', 'invalid-response');
      }

      if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
        throw new QueryRewriteProviderError('OpenAI response is incomplete', 'invalid-response');
      }
      const choice = payload.choices[0];
      // 'length' means the reasoning/output cap starved the completion — invalid, never
      // parsed; a refusal likewise carries no usable structured output.
      if (choice.finish_reason !== 'stop') {
        throw new QueryRewriteProviderError('OpenAI response is incomplete', 'invalid-response');
      }
      const message = choice.message;
      if (!isRecord(message) || (typeof message.refusal === 'string' && message.refusal)) {
        throw new QueryRewriteProviderError('OpenAI response has no text output', 'invalid-response');
      }
      const text = typeof message.content === 'string' ? message.content : '';
      if (!text) throw new QueryRewriteProviderError('OpenAI response has no text output', 'invalid-response');

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new QueryRewriteProviderError('OpenAI returned invalid structured output', 'invalid-response');
      }

      const inputTokens = readTokenCount(payload.usage, 'prompt_tokens');
      const outputTokens = readTokenCount(payload.usage, 'completion_tokens');
      return {
        output,
        usage: {
          inputTokens,
          outputTokens,
          estimatedUsd: estimateLunaCost(inputTokens, outputTokens),
        } satisfies QueryRewriteUsage,
      };
    } catch (error) {
      if (error instanceof QueryRewriteProviderError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new QueryRewriteProviderError('Query rewrite timed out', 'timeout');
      }
      throw new QueryRewriteProviderError('OpenAI request failed', 'upstream');
    } finally {
      clearTimeout(timeout);
    }
  }
}
