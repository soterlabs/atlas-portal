/**
 * Embedding providers for SEARCH-18: local ONNX models via transformers.js, MinishLab
 * model2vec static models, and the OpenAI embeddings API. Corpus embeddings are cached
 * on disk keyed by (model, variant, corpus hash), so a re-run scores in seconds instead
 * of re-embedding.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LocalModelSpec, ModelSpec, OpenAiModelSpec } from './models';
import { loadTransformers } from './transformers-env';

export const CACHE_DIR = process.env.EMBEDDING_CACHE_DIR ?? 'node_modules/.cache/embedding-eval';

const OPENAI_BATCH = 256;

/** L2-normalises in place, so cosine similarity is a plain dot product. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

async function embedLocal(spec: LocalModelSpec, texts: string[], prefix: string): Promise<Float32Array[]> {
  const { pipeline } = await loadTransformers();
  const extractor = await pipeline('feature-extraction', spec.repo, { dtype: spec.dtype ?? 'q8' });

  const vectors: Float32Array[] = [];
  const BATCH = 32;
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH).map((text) => `${prefix}${text}`);
    const output = await extractor(batch, { pooling: spec.pooling, normalize: true });
    const data = output.data as Float32Array;
    for (let row = 0; row < batch.length; row += 1) {
      vectors.push(new Float32Array(data.subarray(row * spec.dims, (row + 1) * spec.dims)));
    }
    output.dispose?.();
    if ((start / BATCH) % 20 === 0)
      process.stderr.write(`\r  embedded ${Math.min(start + BATCH, texts.length)}/${texts.length}`);
  }
  process.stderr.write(`\r  embedded ${texts.length}/${texts.length}\n`);
  return vectors;
}

async function embedOpenAi(spec: OpenAiModelSpec, texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing (set it in .env.local).');

  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += OPENAI_BATCH) {
    const batch = texts.slice(start, start + OPENAI_BATCH).map((text) => text.slice(0, 20_000) || ' ');
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: spec.model, input: batch, ...(spec.dims ? { dimensions: spec.dims } : {}) }),
    });
    if (!response.ok) throw new Error(`OpenAI embeddings failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) vectors.push(normalize(new Float32Array(item.embedding)));
    process.stderr.write(`\r  embedded ${Math.min(start + OPENAI_BATCH, texts.length)}/${texts.length}`);
  }
  process.stderr.write('\n');
  return vectors;
}

/** Embeds passages (cached) or queries (never cached — cheap and tiny). */
export async function embedTexts(
  spec: ModelSpec,
  texts: string[],
  role: 'query' | 'passage',
  cacheKey?: string,
): Promise<Float32Array[]> {
  const path = cacheKey
    ? join(
        CACHE_DIR,
        `${spec.key}-${cacheKey}-${createHash('sha256').update(texts.join(' ')).digest('hex').slice(0, 12)}.bin`,
      )
    : null;

  // Dimensions live in a meta file next to the blob, so providers whose output width is
  // only known at runtime (model2vec) cache the same way as the rest.
  if (path && existsSync(path) && existsSync(`${path}.meta.json`)) {
    const { dims } = JSON.parse(readFileSync(`${path}.meta.json`, 'utf8')) as { dims: number };
    const buffer = readFileSync(path);
    const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 1) vectors.push(new Float32Array(flat.subarray(i * dims, (i + 1) * dims)));
    console.log(`  (cache hit: ${path})`);
    return vectors;
  }

  let vectors: Float32Array[];
  if (spec.kind === 'sparse') {
    throw new Error('sparse specs use the sparse scorer path, not embedTexts');
  }
  if (spec.kind === 'openai') {
    vectors = await embedOpenAi(spec, texts);
  } else if (spec.kind === 'model2vec') {
    const { embedModel2Vec } = await import('./model2vec');
    vectors = await embedModel2Vec(spec.repo, texts);
  } else {
    vectors = await embedLocal(spec, texts, role === 'query' ? spec.queryPrefix : spec.passagePrefix);
  }

  if (path && vectors.length > 0) {
    const dims = vectors[0].length;
    mkdirSync(dirname(path), { recursive: true });
    const flat = new Float32Array(texts.length * dims);
    vectors.forEach((vector, i) => flat.set(vector, i * dims));
    writeFileSync(path, Buffer.from(flat.buffer));
    writeFileSync(`${path}.meta.json`, JSON.stringify({ dims, count: texts.length }));
  }
  return vectors;
}

/**
 * Removes the corpus's shared component from all vectors (SEARCH-18 round 2): subtract
 * the passage centroid, optionally project out the top `components` PCA directions
 * ("all-but-the-top", Mu & Viswanath 2018), renormalise. On a single-domain corpus the
 * dominant directions encode "this is Sky governance", which every document shares;
 * removing them makes cosine measure what *differs* between documents. Queries are
 * transformed with the same centroid/components, computed from passages only.
 */
export function removeSharedComponents(passages: Float32Array[], queries: Float32Array[], components: number): void {
  if (passages.length === 0) return;
  const dims = passages[0].length;

  const centroid = new Float32Array(dims);
  for (const vector of passages) for (let d = 0; d < dims; d += 1) centroid[d] += vector[d];
  for (let d = 0; d < dims; d += 1) centroid[d] /= passages.length;
  for (const vector of [...passages, ...queries]) {
    for (let d = 0; d < dims; d += 1) vector[d] -= centroid[d];
  }

  // Top PCA directions of the centred passages via power iteration with deflation.
  for (let c = 0; c < components; c += 1) {
    let direction = new Float32Array(dims).map(() => 1 / Math.sqrt(dims));
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const next = new Float32Array(dims);
      for (const vector of passages) {
        let dot = 0;
        for (let d = 0; d < dims; d += 1) dot += vector[d] * direction[d];
        for (let d = 0; d < dims; d += 1) next[d] += dot * vector[d];
      }
      normalize(next);
      direction = next;
    }
    for (const vector of [...passages, ...queries]) {
      let dot = 0;
      for (let d = 0; d < dims; d += 1) dot += vector[d] * direction[d];
      for (let d = 0; d < dims; d += 1) vector[d] -= dot * direction[d];
    }
  }

  for (const vector of [...passages, ...queries]) normalize(vector);
}

/** Exact brute-force top-K by dot product (vectors are normalised). */
export function topK(
  query: Float32Array,
  passages: Float32Array[],
  k: number,
): Array<{ index: number; score: number }> {
  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < passages.length; i += 1) {
    const passage = passages[i];
    let dot = 0;
    for (let d = 0; d < query.length; d += 1) dot += query[d] * passage[d];
    scored.push({ index: i, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Embeds passages incrementally: vectors are cached per text, keyed by the SHA-256 of
 * the embedded text, under `<CACHE_DIR>/<cacheName>.bin` (+ `.meta.json`). A small Atlas
 * diff re-embeds only the changed texts (seconds) instead of the whole corpus (minutes).
 * The cache is pruned to the current texts on every write. Used by the per-build
 * artifact steps (document vectors, duplicate census), which run on every deploy.
 */
export async function embedPassagesIncremental(
  spec: ModelSpec,
  texts: string[],
  cacheName: string,
): Promise<{ vectors: Float32Array[]; embedded: number }> {
  // Keyed by the inference stack too: a transformers.js / ONNX Runtime upgrade changes
  // the vectors slightly, and queries are always embedded by the current stack.
  const cachePath = join(CACHE_DIR, `${cacheName}-${inferenceStackTag()}.bin`);
  const metaPath = `${cachePath}.meta.json`;
  const cached = new Map<string, Float32Array>();
  if (existsSync(cachePath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { dims: number; hashes: string[] };
    const buffer = readFileSync(cachePath);
    const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    meta.hashes.forEach((hash, row) => {
      cached.set(hash, new Float32Array(flat.subarray(row * meta.dims, (row + 1) * meta.dims)));
    });
  }
  const hashes = texts.map((text) => createHash('sha256').update(text).digest('hex'));
  const missing = hashes.map((hash, index) => ({ hash, index })).filter(({ hash }) => !cached.has(hash));
  if (missing.length > 0) {
    const embedded = await embedTexts(
      spec,
      missing.map(({ index }) => texts[index]),
      'passage',
    );
    missing.forEach(({ hash }, position) => cached.set(hash, embedded[position]));
  }
  const vectors = hashes.map((hash) => cached.get(hash)!);
  const dims = vectors[0]?.length ?? 0;
  if (dims > 0) {
    const unique = [...new Map(hashes.map((hash) => [hash, cached.get(hash)!]))];
    const flat = new Float32Array(unique.length * dims);
    unique.forEach(([, vector], row) => flat.set(vector, row * dims));
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, Buffer.from(flat.buffer));
    writeFileSync(metaPath, JSON.stringify({ dims, hashes: unique.map(([hash]) => hash) }));
  }
  return { vectors, embedded: missing.length };
}

/** `tf<version>-ort<version>` of the installed transformers.js and onnxruntime-node. */
export function inferenceStackTag(root: string = process.cwd()): string {
  const version = (...segments: string[]): string => {
    const manifest = join(root, 'node_modules', ...segments, 'package.json');
    return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version : '';
  };
  const transformers = version('@huggingface', 'transformers') || 'unknown';
  const ort =
    version('@huggingface', 'transformers', 'node_modules', 'onnxruntime-node') ||
    version('onnxruntime-node') ||
    'unknown';
  return `tf${transformers}-ort${ort}`;
}
