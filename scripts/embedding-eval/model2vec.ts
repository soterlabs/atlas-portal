/**
 * Model2Vec (static embedding) provider for SEARCH-18 — MinishLab's potion models.
 *
 * These are not transformers at inference: the ONNX graph is an EmbeddingBag — flat
 * token ids plus per-row offsets in, mean of static token vectors out. transformers.js's
 * generic pipeline cannot feed that input layout (it sends attention masks, not
 * offsets), so this drives the ONNX session directly: tokenizer via transformers.js,
 * session via onnxruntime-node, output L2-normalised.
 *
 * The distilled quality trade-off is exactly what the harness is for; the draw is speed
 * (no transformer — embedding is a table lookup and an average) and tiny weights.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, normalize } from './embed';
import { loadTransformers } from './transformers-env';

interface Session {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

const sessions = new Map<string, Promise<{ session: Session; tokenize: (texts: string[]) => Promise<number[][]> }>>();

async function load(repo: string) {
  const cached = sessions.get(repo);
  if (cached) return cached;

  const promise = (async () => {
    // Model file: downloaded once into the eval cache (HF redirects, so follow them).
    const modelPath = join(CACHE_DIR, 'models', `${repo.replace('/', '__')}.onnx`);
    if (!existsSync(modelPath)) {
      mkdirSync(join(CACHE_DIR, 'models'), { recursive: true });
      const url = `https://huggingface.co/${repo}/resolve/main/onnx/model.onnx`;
      process.stderr.write(`  downloading ${url} …\n`);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`model download failed: ${response.status}`);
      writeFileSync(modelPath, Buffer.from(await response.arrayBuffer()));
    }

    const ort = (await import('onnxruntime-node')) as unknown as {
      InferenceSession: { create(path: string): Promise<Session> };
      Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    };
    const session = await ort.InferenceSession.create(modelPath);

    const { AutoTokenizer } = await loadTransformers();
    const tokenizer = await AutoTokenizer.from_pretrained(repo);
    const tokenize = async (texts: string[]) => {
      const rows: number[][] = [];
      for (const text of texts) {
        const encoded = tokenizer(text, { add_special_tokens: false });
        const ids = Array.from(encoded.input_ids.data as BigInt64Array, (v) => Number(v));
        rows.push(ids.length > 0 ? ids : [0]);
      }
      return rows;
    };

    return { session, tokenize, ort } as unknown as {
      session: Session;
      tokenize: (texts: string[]) => Promise<number[][]>;
    };
  })();
  sessions.set(repo, promise);
  return promise;
}

export async function embedModel2Vec(repo: string, texts: string[]): Promise<Float32Array[]> {
  const { session, tokenize } = await load(repo);
  const ort = (await import('onnxruntime-node')) as unknown as {
    Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
  };

  const vectors: Float32Array[] = [];
  const BATCH = 512;
  for (let start = 0; start < texts.length; start += BATCH) {
    const rows = await tokenize(texts.slice(start, start + BATCH));
    const offsets = new BigInt64Array(rows.length);
    let total = 0;
    rows.forEach((row, i) => {
      offsets[i] = BigInt(total);
      total += row.length;
    });
    const flat = new BigInt64Array(total);
    let cursor = 0;
    for (const row of rows) for (const id of row) flat[cursor++] = BigInt(id);

    const feeds: Record<string, unknown> = {};
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', flat, [total]);
      else if (name === 'offsets') feeds[name] = new ort.Tensor('int64', offsets, [rows.length]);
      else throw new Error(`unexpected model input '${name}'`);
    }
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];
    const dims = output.dims[output.dims.length - 1];
    for (let row = 0; row < rows.length; row += 1) {
      vectors.push(normalize(new Float32Array(output.data.subarray(row * dims, (row + 1) * dims))));
    }
    process.stderr.write(`\r  embedded ${Math.min(start + BATCH, texts.length)}/${texts.length}`);
  }
  process.stderr.write('\n');

  // Guard against degenerate distillation output: identical vectors for different texts.
  if (vectors.length > 1) {
    const hashOf = (v: Float32Array) =>
      createHash('sha256')
        .update(Buffer.from(v.buffer, v.byteOffset, 64))
        .digest('hex');
    if (hashOf(vectors[0]) === hashOf(vectors[vectors.length - 1]) && texts[0] !== texts[texts.length - 1]) {
      throw new Error('model2vec produced identical vectors for different texts — inference wiring is wrong');
    }
  }
  return vectors;
}
