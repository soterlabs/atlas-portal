#!/usr/bin/env node
/**
 * Post-deploy smoke test for Atlas search: `node scripts/smoke-search.mjs <base-url>`.
 *
 * Exercises what only a real deployment can show (twice now, local build + tests were
 * green while the deployed /api/search/dense returned 500 — untraced native files):
 *   1. the pinned Atlas snapshot and the search artifacts are served and agree;
 *   2. the vendored model and ONNX Runtime Web files are served first-party;
 *   3. POST /api/search/dense embeds a query server-side and returns hits.
 *
 * Protected Vercel deployments: set VERCEL_AUTOMATION_BYPASS_SECRET; it is sent as the
 * x-vercel-protection-bypass header (never in the URL).
 */
const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/smoke-search.mjs <base-url>');
  process.exit(2);
}
const headers = {};
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

async function get(path, init = {}) {
  return fetch(base + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
}

async function json(path) {
  const response = await get(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

try {
  const snapshot = await json('/atlas-snapshot.json');
  check(/^[0-9a-f]{40}$/.test(snapshot.sha ?? ''), 'Atlas snapshot pinned', snapshot.sha?.slice(0, 12));

  const vectors = await json('/atlas-search-vectors.json');
  const index = await json('/atlas-search-index.json');
  check(
    /^[0-9a-f]{64}$/.test(vectors.corpusHash ?? '') && vectors.corpusHash === index.corpusHash,
    'search artifacts from one corpus',
    `${vectors.corpusHash?.slice(0, 12)} · ${vectors.count} vectors`,
  );

  for (const path of [
    '/models/Xenova/bge-small-en-v1.5/config.json',
    '/models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx',
    '/ort/ort-wasm-simd-threaded.asyncify.wasm',
    '/ort/ort-wasm-simd-threaded.wasm',
  ]) {
    const response = await get(path, { method: 'HEAD' });
    check(response.ok, `served first-party ${path}`, `HTTP ${response.status}`);
  }

  // The first call pays the cold start (model load); retry a few times before failing.
  let result = null;
  for (let attempt = 1; attempt <= 3 && !result?.ok; attempt += 1) {
    const response = await get('/api/search/dense', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(base).origin },
      body: JSON.stringify({ query: 'who can freeze a vault', corpusHash: vectors.corpusHash, limit: 5 }),
    });
    const body = await response.json().catch(() => ({}));
    result = { ok: response.ok && Array.isArray(body.hits) && body.hits.length > 0, status: response.status, body };
    if (!result.ok && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
  check(
    result.ok,
    'server dense search (/api/search/dense)',
    result.ok
      ? `${result.body.hits.length} hits`
      : `HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 120)}`,
  );
} catch (error) {
  check(false, 'smoke test ran', error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed on ${base}`);
  process.exit(1);
}
console.log(`\nAll search checks passed on ${base}`);
