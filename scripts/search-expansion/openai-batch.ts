/**
 * OpenAI Batch API driver for expansion generation (SEARCH-17), used when the available
 * key is an OpenAI one (`--provider openai`). Plain `fetch` — no SDK dependency; the
 * batch flow is: upload a JSONL file of chat-completion requests → create a batch over
 * it → poll → download the output file and parse it line by line.
 *
 * The pure JSONL builders/parsers are exported for unit tests; only the async functions
 * touch the network. Submission waits for the uploaded file to be `processed` and
 * retries batch creation on the "Cannot find file" race (observed in the first pilot:
 * the file existed and was processed, but a batch created in the same instant failed
 * validation). `collectOpenAiBatch` harvests an existing batch, so an interrupted run —
 * or one that failed after submission — can be resumed with `--resume-batch <id>`.
 */

export interface BatchRequestInput {
  customId: string;
  prompt: string;
}

export interface BatchResultLine {
  customId: string;
  ok: boolean;
  /** Model reply text when ok; error description otherwise. */
  text: string;
}

const API = 'https://api.openai.com/v1';
const CREATE_RETRIES = 5;
const CREATE_RETRY_MS = 5_000;

/** One JSONL line of the batch input file. */
export function buildRequestLine(input: BatchRequestInput, model: string, maxTokens: number): string {
  return JSON.stringify({
    custom_id: input.customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      // Reasoning tokens count against this cap on the gpt-5 family — a tight cap makes
      // the model spend everything thinking and return empty content (observed:
      // finish_reason 'length', reasoning_tokens == cap, content ''). Keep it generous.
      max_completion_tokens: maxTokens,
      messages: [{ role: 'user', content: input.prompt }],
    },
  });
}

/** Parses one JSONL line of the batch output file. */
export function parseOutputLine(line: string): BatchResultLine {
  const parsed = JSON.parse(line) as {
    custom_id: string;
    error?: { message?: string } | null;
    response?: {
      status_code?: number;
      body?: { choices?: Array<{ message?: { content?: string | null } }> };
    } | null;
  };

  if (parsed.error) {
    return { customId: parsed.custom_id, ok: false, text: parsed.error.message ?? 'batch error' };
  }
  if (parsed.response?.status_code !== 200) {
    return { customId: parsed.custom_id, ok: false, text: `status ${parsed.response?.status_code}` };
  }
  const content = parsed.response.body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return { customId: parsed.custom_id, ok: false, text: 'empty completion' };
  }
  return { customId: parsed.custom_id, ok: true, text: content };
}

async function openAiFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`OpenAI ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

export interface OpenAiBatchOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  pollMs: number;
  log: (message: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Uploads the JSONL input and creates the batch, riding out the file-visibility race. */
export async function submitOpenAiBatch(
  inputs: BatchRequestInput[],
  { apiKey, model, maxTokens, log }: Omit<OpenAiBatchOptions, 'pollMs'>,
): Promise<string> {
  const jsonl = inputs.map((input) => buildRequestLine(input, model, maxTokens)).join('\n');

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'expansion-batch.jsonl');
  const file = (await (await openAiFetch(apiKey, '/files', { method: 'POST', body: form })).json()) as { id: string };
  log(`Uploaded batch input file ${file.id} (${inputs.length} requests).`);

  // Wait until the file reports `processed` before referencing it from a batch.
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt += 1) {
    const meta = (await (await openAiFetch(apiKey, `/files/${file.id}`)).json()) as { status?: string };
    if (meta.status === 'processed') break;
    log(`  input file ${meta.status ?? 'pending'}; waiting …`);
    await sleep(CREATE_RETRY_MS);
  }

  let lastError = '';
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt += 1) {
    if (attempt > 0) {
      log(`  batch creation retry ${attempt} (${lastError.slice(0, 80)}) …`);
      await sleep(CREATE_RETRY_MS * attempt);
    }
    const batch = (await (
      await openAiFetch(apiKey, '/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
        }),
      })
    ).json()) as { id: string; status: string; errors?: { data?: Array<{ message?: string }> } | null };

    // A batch can be accepted and then fail validation moments later on the same race —
    // check the immediate status before trusting it.
    await sleep(2_000);
    const checked = (await (await openAiFetch(apiKey, `/batches/${batch.id}`)).json()) as typeof batch;
    if (checked.status !== 'failed') {
      log(`Batch ${batch.id} submitted (${checked.status}).`);
      return batch.id;
    }
    lastError = checked.errors?.data?.map((entry) => entry.message).join('; ') ?? 'failed';
    if (!lastError.includes('Cannot find file')) throw new Error(`Batch failed on submission: ${lastError}`);
  }
  throw new Error(`Batch creation kept failing: ${lastError}`);
}

/** Polls an existing batch to completion and downloads its results. */
export async function collectOpenAiBatch(
  batchId: string,
  { apiKey, pollMs, log }: Pick<OpenAiBatchOptions, 'apiKey' | 'pollMs' | 'log'>,
): Promise<BatchResultLine[]> {
  let status: {
    status: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    request_counts?: { completed?: number; failed?: number; total?: number };
    errors?: { data?: Array<{ message?: string }> } | null;
  };
  for (;;) {
    status = (await (await openAiFetch(apiKey, `/batches/${batchId}`)).json()) as typeof status;
    const counts = status.request_counts;
    log(`  ${status.status}: ${counts?.completed ?? 0}/${counts?.total ?? '?'} done, ${counts?.failed ?? 0} failed`);
    if (['completed', 'failed', 'expired', 'cancelled'].includes(status.status)) break;
    await sleep(pollMs);
  }
  if (status.status !== 'completed') {
    const detail = status.errors?.data?.map((entry) => entry.message).join('; ') ?? '';
    throw new Error(`Batch ended as ${status.status}${detail ? `: ${detail}` : ''}`);
  }

  const results: BatchResultLine[] = [];
  for (const fileId of [status.output_file_id, status.error_file_id]) {
    if (!fileId) continue;
    const body = await (await openAiFetch(apiKey, `/files/${fileId}/content`)).text();
    for (const line of body.split('\n')) {
      if (line.trim()) results.push(parseOutputLine(line));
    }
  }
  return results;
}

/** Submit + collect in one call — the normal, uninterrupted path. */
export async function runOpenAiBatch(
  inputs: BatchRequestInput[],
  options: OpenAiBatchOptions,
): Promise<BatchResultLine[]> {
  const batchId = await submitOpenAiBatch(inputs, options);
  return collectOpenAiBatch(batchId, options);
}

const DEFAULT_SYNC_CONCURRENCY = 8;
const SYNC_RETRIES = 3;

/**
 * Synchronous fallback (`--no-batch`): plain chat completions with bounded concurrency
 * and retry on 429/5xx. Twice the batch price, but works on orgs whose data-retention
 * settings block the Batch API's stored files (observed on the pilot account: every
 * batch failed validation with "Cannot find file … or organization does not have access"
 * even for a processed, curl-uploaded file).
 */
export async function runOpenAiSync(
  inputs: BatchRequestInput[],
  {
    apiKey,
    model,
    maxTokens,
    log,
    concurrency = DEFAULT_SYNC_CONCURRENCY,
  }: Omit<OpenAiBatchOptions, 'pollMs'> & { concurrency?: number },
): Promise<BatchResultLine[]> {
  const results: BatchResultLine[] = new Array(inputs.length);
  let next = 0;
  let done = 0;

  async function one(index: number): Promise<void> {
    const input = inputs[index];
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_completion_tokens: maxTokens,
          messages: [{ role: 'user', content: input.prompt }],
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const content = body.choices?.[0]?.message?.content;
        results[index] =
          typeof content === 'string' && content.trim()
            ? { customId: input.customId, ok: true, text: content }
            : { customId: input.customId, ok: false, text: 'empty completion' };
        return;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= SYNC_RETRIES) {
        results[index] = { customId: input.customId, ok: false, text: `status ${response.status}` };
        return;
      }
      await sleep(2_000 * (attempt + 1));
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      if (index >= inputs.length) return;
      next += 1;
      await one(index);
      done += 1;
      if (done % 25 === 0 || done === inputs.length) log(`  ${done}/${inputs.length} completed`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}
