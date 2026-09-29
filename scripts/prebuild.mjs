#!/usr/bin/env node
/**
 * Runs before `next build` (npm `prebuild`). Makes every deployment internally
 * consistent by construction:
 *
 *   1. Pin the Atlas: resolve the head of sky-ecosystem/next-gen-atlas once and record
 *      it in `.atlas-snapshot.json` (read by next.config.ts, which inlines it as
 *      ATLAS_PINNED_SHA so the page and /api/atlas.* serve exactly this commit) and in
 *      `public/atlas-snapshot.json` (what the redeploy workflow compares against).
 *   2. Build the search artifacts from that same commit (scripts/refresh-search-artifacts.ts).
 *      Document vectors are cached under .next/cache, which Vercel keeps between
 *      builds, so only changed documents are re-embedded.
 *   3. Copy the ONNX Runtime Web files to public/ort/ (scripts/copy-ort-wasm.mjs).
 *
 * ATLAS_PINNED_SHA=<sha> builds a specific commit instead of the head.
 * SKIP_SEARCH_ARTIFACTS=1 skips step 2 (quick local builds; search then degrades).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'sky-ecosystem/next-gen-atlas';
const BRANCH = 'main';
const SHA = /^[0-9a-f]{40}$/;

async function resolveHead() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'atlas-portal-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${REPO}@${BRANCH}: HTTP ${response.status}`);
  const commit = await response.json();
  if (!SHA.test(commit.sha ?? '')) throw new Error(`GitHub returned no commit sha for ${REPO}@${BRANCH}`);
  return { sha: commit.sha, committedAt: commit.commit?.committer?.date ?? null };
}

function step(label, command, args, env) {
  console.log(`\n[prebuild] ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`[prebuild] ${label} failed (exit ${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
}

const requested = process.env.ATLAS_PINNED_SHA;
if (requested && !SHA.test(requested)) {
  console.error(`[prebuild] ATLAS_PINNED_SHA must be a full 40-character commit sha, got "${requested}"`);
  process.exit(1);
}
const snapshot = requested ? { sha: requested, committedAt: null } : await resolveHead();
const record = { repo: REPO, ...snapshot, pinnedAt: new Date().toISOString() };
writeFileSync('.atlas-snapshot.json', `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(join('public', 'atlas-snapshot.json'), `${JSON.stringify(record)}\n`);
console.log(`[prebuild] Atlas pinned at ${REPO}@${snapshot.sha.slice(0, 12)}`);

if (process.env.SKIP_SEARCH_ARTIFACTS === '1') {
  console.warn('[prebuild] SKIP_SEARCH_ARTIFACTS=1 — search artifacts NOT built; search will degrade.');
} else {
  const cacheDir = join('.next', 'cache', 'search-embeddings');
  mkdirSync(cacheDir, { recursive: true });
  step('search artifacts', 'npx', ['tsx', 'scripts/refresh-search-artifacts.ts'], {
    ATLAS_PINNED_SHA: snapshot.sha,
    EMBEDDING_CACHE_DIR: cacheDir,
  });
}

step('ONNX Runtime Web files', process.execPath, ['scripts/copy-ort-wasm.mjs']);
