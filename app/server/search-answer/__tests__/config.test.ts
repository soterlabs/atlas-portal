import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAnswersConfigured } from '../config';

describe('searchAnswersConfigured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on only for the OpenAI provider with a key: the answer route has no Anthropic implementation', () => {
    vi.stubEnv('SEARCH_ANSWERS_ENABLED', 'true');
    vi.stubEnv('QUERY_REWRITE_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(searchAnswersConfigured()).toBe(false);

    vi.stubEnv('QUERY_REWRITE_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(searchAnswersConfigured()).toBe(true);
  });

  it('stays off without the flag', () => {
    vi.stubEnv('SEARCH_ANSWERS_ENABLED', '');
    vi.stubEnv('QUERY_REWRITE_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(searchAnswersConfigured()).toBe(false);
  });
});
