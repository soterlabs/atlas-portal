#!/usr/bin/env node
/**
 * CLI: generate search-expansion text (SEARCH-17) for Atlas documents whose source text
 * changed since their last entry — incremental by document hash, so the weekly run after
 * the first full pass costs cents.
 *
 * Usage:
 *   npx tsx scripts/search-expansion/generate.ts [corpus-url] --dry-run     # write prompts, no API
 *   npx tsx scripts/search-expansion/generate.ts [corpus-url] --pilot 50    # first 50 stale docs
 *   npx tsx scripts/search-expansion/generate.ts [corpus-url] --full        # everything stale
 *   … --provider openai|anthropic     # default: whichever key the environment has
 *   … --model <id>                    # override the provider's default model
 *
 * Keys are read from the environment; `.env.local` (gitignored) is loaded automatically,
 * so put `OPENAI_API_KEY=…` or `ANTHROPIC_API_KEY=…` there (decision D1: server-held).
 * Both providers use their batch endpoint (~50% price). Rejected entries (leak check,
 * parse failures) are reported and NOT written to the store.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, writeFileSync } from 'node:fs';
import { flattenAtlasDocuments } from '../../app/atlas/search/flatten-documents';
import { type ExportAtlasTreeDocument, childCollectionNames } from '../../app/server/atlas/export/types';
import { type BatchResultLine, collectOpenAiBatch, runOpenAiBatch, runOpenAiSync } from './openai-batch';
import { type ExpansionInput, buildPrompt, findLeaks, parseExpansionResponse } from './prompt';
import { STORE_PATH, documentHash, documentKey, loadStore, saveStore, staleDocuments } from './store';

const DEFAULT_MODELS = { anthropic: 'claude-opus-5', openai: 'gpt-5.6-luna' } as const;
// Includes reasoning tokens on reasoning models (gpt-5 family) — 1024 starved them into
// empty completions. Generous by decision: the task is tiny, the corpus is small.
const MAX_TOKENS = 16000;
const POLL_MS = 60_000;

/** Loads .env.local / .env into process.env (tsx does not; Next.js only does for its own processes). */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** Maps every child document key to its parent's body, for prompt context. */
function parentContentByKey(scopeTrees: ExportAtlasTreeDocument[]): Map<string, string> {
  const map = new Map<string, string>();

  function traverse(doc: ExportAtlasTreeDocument): void {
    for (const collection of childCollectionNames) {
      const children = (doc as unknown as Record<string, unknown>)[collection];
      if (!Array.isArray(children)) continue;
      for (const child of children as ExportAtlasTreeDocument[]) {
        const key = child.uuid ?? child.doc_no;
        if (key && doc.content) map.set(key, doc.content);
        traverse(child);
      }
    }
  }

  for (const tree of scopeTrees) traverse(tree);
  return map;
}

async function fetchCorpus(url: string): Promise<ExportAtlasTreeDocument[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as ExportAtlasTreeDocument[];
}

function pickProvider(explicit: string | null): 'anthropic' | 'openai' {
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  if (explicit) throw new Error(`Unknown provider '${explicit}' (use anthropic or openai).`);
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new Error('No API key found: set ANTHROPIC_API_KEY or OPENAI_API_KEY (e.g. in .env.local).');
}

async function runAnthropicBatch(inputs: ExpansionInput[], model: string): Promise<BatchResultLine[]> {
  const client = new Anthropic();
  const batch = await client.messages.batches.create({
    requests: inputs.map((input) => ({
      custom_id: documentKey(input.doc),
      params: {
        model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: buildPrompt(input) }],
      },
    })),
  });
  console.log(`Batch ${batch.id} submitted; polling every ${POLL_MS / 1000}s …`);

  let status = batch;
  while (status.processing_status !== 'ended') {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    status = await client.messages.batches.retrieve(batch.id);
    console.log(
      `  ${status.processing_status}: ${status.request_counts.succeeded} ok, ` +
        `${status.request_counts.errored} errored, ${status.request_counts.processing} processing`,
    );
  }

  const results: BatchResultLine[] = [];
  for await (const result of await client.messages.batches.results(batch.id)) {
    if (result.result.type !== 'succeeded') {
      results.push({ customId: result.custom_id, ok: false, text: result.result.type });
      continue;
    }
    const text = result.result.message.content
      .filter((block): block is { type: 'text'; text: string } & typeof block => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    results.push({ customId: result.custom_id, ok: true, text });
  }
  return results;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const args = process.argv.slice(2);
  const flagValue = (name: string): string | null => {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
  };
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
  const url = positional[0] ?? 'http://localhost:3000/api/atlas.json';
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const pilot = args.includes('--pilot') ? Number(flagValue('--pilot') ?? 50) : null;
  const resumeBatch = flagValue('--resume-batch');

  if (!dryRun && !full && pilot === null && !resumeBatch) {
    throw new Error('Pick one of --dry-run, --pilot <n>, --full, --resume-batch <id> (cost control is explicit).');
  }

  console.log(`Fetching corpus from ${url} …`);
  const scopeTrees = await fetchCorpus(url);
  const documents = flattenAtlasDocuments(scopeTrees);
  const parents = parentContentByKey(scopeTrees);
  const store = loadStore();

  if (resumeBatch) {
    // Harvest an already-submitted OpenAI batch (e.g. after an interrupt or a submission
    // that recovered out-of-band). Inputs are recomputed from the corpus so the leak
    // check and hashes work; custom_ids are document keys, so matching is exact.
    const allInputs: ExpansionInput[] = documents.map((doc) => ({
      doc,
      parentContent: parents.get(documentKey(doc)),
    }));
    const results = await collectOpenAiBatch(resumeBatch, {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      pollMs: POLL_MS,
      log: (message) => console.log(message),
    });
    ingest(results, allInputs, store, `openai:${flagValue('--model') ?? DEFAULT_MODELS.openai}`);
    return;
  }

  let stale = staleDocuments(documents, store);
  console.log(`${documents.length} documents; ${stale.length} stale (no current expansion).`);
  if (pilot !== null) stale = stale.slice(0, pilot);
  if (stale.length === 0) {
    console.log('Nothing to generate.');
    return;
  }

  const inputs: ExpansionInput[] = stale.map((doc) => ({ doc, parentContent: parents.get(documentKey(doc)) }));

  if (dryRun) {
    const out = 'data/search/expansion-batch-requests.json';
    writeFileSync(
      out,
      JSON.stringify(
        inputs.map((input) => ({ custom_id: documentKey(input.doc), prompt: buildPrompt(input) })),
        null,
        2,
      ),
    );
    console.log(`Dry run: wrote ${inputs.length} prompts to ${out}. First prompt:\n`);
    console.log(buildPrompt(inputs[0]));
    return;
  }

  const provider = pickProvider(flagValue('--provider'));
  const model = flagValue('--model') ?? DEFAULT_MODELS[provider];
  console.log(`Submitting ${inputs.length} requests via ${provider} (${model}) …`);

  const openAiOptions = {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model,
    maxTokens: MAX_TOKENS,
    pollMs: POLL_MS,
    log: (message: string) => console.log(message),
    concurrency: Number(flagValue('--concurrency') ?? 0) || undefined,
  };
  const toOpenAiInputs = (chunk: ExpansionInput[]) =>
    chunk.map((input) => ({ customId: documentKey(input.doc), prompt: buildPrompt(input) }));

  if (provider === 'openai' && args.includes('--no-batch')) {
    // Long synchronous runs are chunked, with the store saved after every chunk: a crash
    // or interrupt loses at most one chunk, and re-running skips everything already
    // stored (stale detection is by document hash).
    const CHUNK = 500;
    for (let start = 0; start < inputs.length; start += CHUNK) {
      const chunk = inputs.slice(start, start + CHUNK);
      console.log(`\nChunk ${start / CHUNK + 1}/${Math.ceil(inputs.length / CHUNK)} (${chunk.length} documents)`);
      const results = await runOpenAiSync(toOpenAiInputs(chunk), openAiOptions);
      ingest(results, chunk, store, `${provider}:${model}`);
    }
    return;
  }

  const results =
    provider === 'anthropic'
      ? await runAnthropicBatch(inputs, model)
      : await runOpenAiBatch(toOpenAiInputs(inputs), openAiOptions);

  ingest(results, inputs, store, `${provider}:${model}`);
}

/** Parses, leak-checks and stores batch results; reports what was rejected. */
function ingest(
  results: BatchResultLine[],
  inputs: ExpansionInput[],
  store: ReturnType<typeof loadStore>,
  provenance: string,
): void {
  const byKey = new Map(inputs.map((input) => [documentKey(input.doc), input]));
  let written = 0;
  const rejected: Array<{ key: string; reason: string }> = [];

  for (const result of results) {
    const input = byKey.get(result.customId);
    if (!input) continue;
    if (!result.ok) {
      rejected.push({ key: result.customId, reason: result.text });
      continue;
    }
    try {
      const expansion = parseExpansionResponse(result.text);
      const leaks = findLeaks(expansion, input);
      if (leaks.length > 0) {
        rejected.push({ key: result.customId, reason: `leaks: ${leaks.join(', ')}` });
        continue;
      }
      store.entries[result.customId] = {
        hash: documentHash(input.doc),
        paraphrase: expansion.paraphrase,
        questions: expansion.questions,
        model: provenance,
      };
      written += 1;
    } catch (error) {
      rejected.push({ key: result.customId, reason: String(error) });
    }
  }

  saveStore(store);
  console.log(`\nWrote ${written} entries to ${STORE_PATH}; ${rejected.length} rejected.`);
  for (const entry of rejected.slice(0, 20)) console.log(`  ✗ ${entry.key} — ${entry.reason}`);
  if (rejected.length > 20) console.log(`  … and ${rejected.length - 20} more`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
