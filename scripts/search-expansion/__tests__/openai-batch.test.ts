import { describe, expect, it } from 'vitest';
import { buildRequestLine, parseOutputLine } from '../openai-batch';

describe('buildRequestLine', () => {
  it('produces one valid JSONL chat-completion request', () => {
    const line = buildRequestLine({ customId: 'uuid-1', prompt: 'Hello' }, 'gpt-5-mini', 1024);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      custom_id: 'uuid-1',
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5-mini',
        max_completion_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    expect(line).not.toContain('\n');
  });
});

describe('parseOutputLine', () => {
  it('extracts the completion text from a successful line', () => {
    const line = JSON.stringify({
      custom_id: 'uuid-1',
      error: null,
      response: { status_code: 200, body: { choices: [{ message: { content: '{"paraphrase":"p"}' } }] } },
    });
    expect(parseOutputLine(line)).toEqual({ customId: 'uuid-1', ok: true, text: '{"paraphrase":"p"}' });
  });

  it('reports batch-level errors, non-200 responses, and empty completions as failures', () => {
    expect(parseOutputLine(JSON.stringify({ custom_id: 'a', error: { message: 'rate limited' } }))).toEqual({
      customId: 'a',
      ok: false,
      text: 'rate limited',
    });
    expect(parseOutputLine(JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: {} } }))).toEqual({
      customId: 'b',
      ok: false,
      text: 'status 400',
    });
    expect(
      parseOutputLine(
        JSON.stringify({
          custom_id: 'c',
          response: { status_code: 200, body: { choices: [{ message: { content: '' } }] } },
        }),
      ),
    ).toEqual({ customId: 'c', ok: false, text: 'empty completion' });
  });
});
