/**
 * Model registry for the embedding comparison (SEARCH-18).
 *
 * Prefixes matter: bge/e5/nomic-style models are trained with asymmetric instruction
 * prefixes, and running them without (or with the wrong ones) costs several nDCG points —
 * the registry carries each model's convention so the harness cannot get it wrong.
 * Pooling likewise: bge models use CLS pooling, the others mean pooling.
 */

export interface LocalModelSpec {
  kind: 'local';
  /** Hugging Face repo with ONNX weights, loaded by transformers.js. */
  repo: string;
  dims: number;
  pooling: 'mean' | 'cls';
  queryPrefix: string;
  passagePrefix: string;
  /** ONNX weight precision; default q8 (what the browser would ship). */
  dtype?: 'q8' | 'fp32' | 'fp16';
}

export interface OpenAiModelSpec {
  kind: 'openai';
  model: string;
  /** Matryoshka truncation via the API's `dimensions` parameter; undefined = native. */
  dims?: number;
}

/** MinishLab model2vec static-embedding models (EmbeddingBag ONNX; no transformer). */
export interface Model2VecSpec {
  kind: 'model2vec';
  repo: string;
}

/** A learned-sparse (SPLADE-class) model: MLM doc-side encoder (embed round-3 §2.2). */
export interface SparseModelSpec {
  kind: 'sparse';
  /** Hugging Face repo id or absolute local artifact path (needs ONNX weights). */
  repo: string;
  /**
   * Query-side convention: 'same-model' runs the doc encoder on the query;
   * 'inference-free' uses the checkpoint's shipped idf.json weights over query
   * tokens (the opensearch doc-v2-distill convention).
   */
  querySide: 'same-model' | 'inference-free';
  dtype?: 'q8' | 'fp32' | 'fp16';
  /** Surfaced at load and recorded in reports; never checked programmatically. */
  license?: string;
}

export type ModelSpec = (LocalModelSpec | OpenAiModelSpec | Model2VecSpec | SparseModelSpec) & { key: string };

export const MODELS: ModelSpec[] = [
  {
    key: 'minilm',
    kind: 'local',
    repo: 'Xenova/all-MiniLM-L6-v2',
    dims: 384,
    pooling: 'mean',
    queryPrefix: '',
    passagePrefix: '',
  },
  {
    key: 'bge-small',
    kind: 'local',
    repo: 'Xenova/bge-small-en-v1.5',
    dims: 384,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
  {
    key: 'leaf-ir',
    kind: 'local',
    // The card headlines 768d (MRL), but the repo's ONNX export outputs 384 — verified
    // empirically (dims [n, 384]); the registry describes the artifact we actually load.
    repo: 'MongoDB/mdbr-leaf-ir',
    dims: 384,
    pooling: 'mean',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
  {
    key: 'granite-small',
    kind: 'local',
    // The ibm-granite repo ships no ONNX weights (load fails); the onnx-community
    // mirror is the loadable export.
    repo: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    dims: 384,
    pooling: 'cls',
    queryPrefix: '',
    passagePrefix: '',
  },
  {
    key: 'bge-base',
    kind: 'local',
    repo: 'Xenova/bge-base-en-v1.5',
    dims: 768,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
  {
    key: 'gte-base',
    kind: 'local',
    repo: 'Xenova/gte-base',
    dims: 768,
    pooling: 'mean',
    queryPrefix: '',
    passagePrefix: '',
  },
  {
    key: 'nomic',
    kind: 'local',
    repo: 'nomic-ai/nomic-embed-text-v1.5',
    dims: 768,
    pooling: 'mean',
    queryPrefix: 'search_query: ',
    passagePrefix: 'search_document: ',
  },
  { key: 'openai-small', kind: 'openai', model: 'text-embedding-3-small' },
  { key: 'openai-small-256', kind: 'openai', model: 'text-embedding-3-small', dims: 256 },
  { key: 'potion-retrieval-32m', kind: 'model2vec', repo: 'minishlab/potion-retrieval-32M' },
  { key: 'potion-base-8m', kind: 'model2vec', repo: 'minishlab/potion-base-8M' },
  {
    // The upstream BAAI weights at full precision: verifies the Xenova q8 mirror is
    // faithful and measures what q8 quantisation costs (R3's quantisation question,
    // model side). Same v1.5 weights — there is no newer small English BGE.
    key: 'bge-small-fp32',
    kind: 'local',
    repo: 'BAAI/bge-small-en-v1.5',
    dims: 384,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
    dtype: 'fp32',
  },
];

export function modelByKey(key: string): ModelSpec {
  const spec = MODELS.find((model) => model.key === key);
  if (!spec) throw new Error(`Unknown model '${key}'. Known: ${MODELS.map((m) => m.key).join(', ')}`);
  return spec;
}

const POOLINGS = ['cls', 'mean'] as const;
const DTYPES = ['q8', 'fp32', 'fp16'] as const;
const QUERY_SIDES = ['same-model', 'inference-free'] as const;

/**
 * A tuned-artifact spec file: the same fields as a registry entry, where
 * `repo` may be an absolute local path to an artifact directory in the HF layout
 * (config.json + tokenizer files + onnx/model_quantized.onnx — transformers.js
 * resolves local paths). Unknown extra fields are ignored (the finetuning exporter
 * records training metadata alongside); the fields the harness consumes are validated
 * strictly, and pooling refuses anything outside the known values.
 *
 * The spec's `key` names the disk cache and the report exactly as registry keys do —
 * so it must be unique per artifact, and a key colliding with a registry entry is
 * REFUSED: the vector cache is keyed by (key, corpus, texts), not by weights, and a
 * collision would silently serve another model's cached vectors.
 */
export function loadSpecFile(raw: string): ModelSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--spec file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--spec file must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new Error(`--spec file invalid: ${message}`);
  };
  // Some spec files write `name` for sparse specs; the established field is
  // `key` — both are accepted, `key` wins when both are present.
  const rawKey = record.key ?? record.name;
  const key =
    typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : fail('key (or name) must be a non-empty string');
  if (MODELS.some((model) => model.key === key)) {
    fail(`key '${key}' collides with a registry model — a colliding key would reuse that model's vector cache`);
  }
  const repo =
    typeof record.repo === 'string' && record.repo.trim()
      ? record.repo.trim()
      : fail('repo must be a non-empty string (HF repo id or absolute artifact path)');
  const license = typeof record.license === 'string' ? record.license : undefined;
  const dtype =
    record.dtype === undefined
      ? undefined
      : (DTYPES as readonly string[]).includes(record.dtype as string)
        ? (record.dtype as (typeof DTYPES)[number])
        : fail(`dtype, when present, must be one of: ${DTYPES.join(', ')}`);

  if (record.kind === 'sparse') {
    const querySide = (QUERY_SIDES as readonly string[]).includes(record.querySide as string)
      ? (record.querySide as (typeof QUERY_SIDES)[number])
      : fail(`querySide must be one of: ${QUERY_SIDES.join(', ')}`);
    if (license) console.log(`  spec license: ${license}`);
    return {
      key,
      kind: 'sparse',
      repo,
      querySide,
      ...(dtype ? { dtype } : {}),
      ...(license ? { license } : {}),
    };
  }

  const dims =
    typeof record.dims === 'number' && Number.isInteger(record.dims) && record.dims > 0
      ? record.dims
      : fail('dims must be a positive integer');
  const pooling = (POOLINGS as readonly string[]).includes(record.pooling as string)
    ? (record.pooling as (typeof POOLINGS)[number])
    : fail(`pooling must be one of: ${POOLINGS.join(', ')}`);
  const prefix = (name: 'queryPrefix' | 'passagePrefix'): string =>
    typeof record[name] === 'string'
      ? (record[name] as string)
      : fail(`${name} must be a string (empty when the model uses no prompt)`);
  return {
    key,
    kind: 'local',
    repo,
    dims,
    pooling,
    queryPrefix: prefix('queryPrefix'),
    passagePrefix: prefix('passagePrefix'),
    ...(dtype ? { dtype } : {}),
  };
}
