/**
 * Answer provider seam (SEARCH-25) and its OpenAI implementation.
 *
 * The provider seam is shared with the query-rewrite feature (one provider selection,
 * one key). The shipped implementation is OpenAI; an Anthropic implementation can slot
 * in unchanged once a key is configured.
 *
 * gpt-5-family conventions inherited from SEARCH-17/23: `max_completion_tokens` includes
 * reasoning tokens (generous cap), and `finish_reason: 'length'` is an invalid response,
 * never silently parsed.
 */
import { type AnswerContextPolicy, DEFAULT_ANSWER_CONTEXT_POLICY } from './context-policy';
import {
  ANSWER_OUTPUT_JSON_SCHEMA,
  type AnswerContextDocument,
  type AnswerModelOutputShape,
  answerSystemPrompt,
  buildAnswerUserPrompt,
} from './prompt';

const OPENAI_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMPLETION_TOKENS = 16_000;

export const OPENAI_ANSWER_MODEL = 'gpt-5.6-luna';

// List pricing on 2026-09-01, explicit for reproducible cost reporting.
export const LUNA_INPUT_USD_PER_MILLION = 0.2;
export const LUNA_OUTPUT_USD_PER_MILLION = 1.2;

export interface ProviderAnswerResult {
  output: AnswerModelOutputShape;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AnswerProvider {
  readonly model: string;
  answer(
    query: string,
    documents: AnswerContextDocument[],
    policy?: AnswerContextPolicy,
  ): Promise<ProviderAnswerResult>;
}

export class AnswerProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'configuration' | 'network' | 'invalid-response' | 'upstream',
  ) {
    super(message);
    this.name = 'AnswerProviderError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTokenCount(usage: unknown, key: 'prompt_tokens' | 'completion_tokens'): number {
  if (!isRecord(usage)) throw new AnswerProviderError('OpenAI response has invalid usage', 'invalid-response');
  const value = usage[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AnswerProviderError('OpenAI response has invalid usage', 'invalid-response');
  }
  return value;
}

/** Parses the strict-schema model output; throws on any structural surprise. */
export function parseAnswerModelOutput(raw: string): AnswerModelOutputShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnswerProviderError('model output is not valid JSON', 'invalid-response');
  }
  if (!isRecord(parsed) || typeof parsed.abstain !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new AnswerProviderError('model output has an invalid shape', 'invalid-response');
  }
  if (!Array.isArray(parsed.claims))
    throw new AnswerProviderError('model output claims must be an array', 'invalid-response');
  const claims = parsed.claims.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.text !== 'string' ||
      typeof entry.quote !== 'string' ||
      typeof entry.doc_no !== 'string'
    ) {
      throw new AnswerProviderError('model output claim has an invalid shape', 'invalid-response');
    }
    return { text: entry.text.trim(), quote: entry.quote.trim(), doc_no: entry.doc_no.trim() };
  });
  if (!parsed.abstain && claims.length === 0) {
    throw new AnswerProviderError('model neither abstained nor produced claims', 'invalid-response');
  }
  return { abstain: parsed.abstain, reason: parsed.reason.trim(), claims };
}

interface OpenAiAnswerProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** reasoning_effort for the gpt-5 family; low keeps the explicit action responsive. */
  effort?: 'low' | 'high';
}

export class OpenAiAnswerProvider implements AnswerProvider {
  readonly model = OPENAI_ANSWER_MODEL;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly effort: 'low' | 'high';

  constructor(options: OpenAiAnswerProviderOptions) {
    if (!options.apiKey.trim()) throw new AnswerProviderError('OpenAI API key is not configured', 'configuration');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.effort = options.effort ?? 'low';
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AnswerProviderError('timeout must be positive', 'configuration');
    }
  }

  async answer(
    query: string,
    documents: AnswerContextDocument[],
    policy: AnswerContextPolicy = DEFAULT_ANSWER_CONTEXT_POLICY,
  ): Promise<ProviderAnswerResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(OPENAI_COMPLETIONS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          reasoning_effort: this.effort,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          response_format: { type: 'json_schema', json_schema: ANSWER_OUTPUT_JSON_SCHEMA },
          messages: [
            { role: 'system', content: answerSystemPrompt(policy) },
            { role: 'user', content: buildAnswerUserPrompt(query, documents, policy) },
          ],
        }),
      });
      if (!response.ok) {
        throw new AnswerProviderError(`OpenAI request failed with status ${response.status}`, 'upstream');
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
        throw new AnswerProviderError('OpenAI response has an invalid shape', 'invalid-response');
      }
      const choice = payload.choices[0] as Record<string, unknown>;
      if (choice.finish_reason === 'length') {
        throw new AnswerProviderError('OpenAI completion was truncated (finish_reason length)', 'invalid-response');
      }
      const message = choice.message;
      if (!isRecord(message) || typeof message.content !== 'string') {
        throw new AnswerProviderError('OpenAI response has no message content', 'invalid-response');
      }
      const inputTokens = readTokenCount(payload.usage, 'prompt_tokens');
      const outputTokens = readTokenCount(payload.usage, 'completion_tokens');
      return {
        output: parseAnswerModelOutput(message.content),
        inputTokens,
        outputTokens,
        estimatedCostUsd:
          (inputTokens * LUNA_INPUT_USD_PER_MILLION + outputTokens * LUNA_OUTPUT_USD_PER_MILLION) / 1_000_000,
      };
    } catch (error) {
      if (error instanceof AnswerProviderError) throw error;
      throw new AnswerProviderError(`OpenAI request failed: ${(error as Error).message}`, 'network');
    } finally {
      clearTimeout(timeout);
    }
  }
}
