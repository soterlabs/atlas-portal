#!/usr/bin/env node
// Copies the ONNX Runtime Web loader + WASM files that transformers.js uses in the
// browser into public/ort/, so they are served same-origin instead of from
// cdn.jsdelivr.net (see configureFirstPartyAssets in app/atlas/search/embedding-model.ts).
// Runs before `dev` and `build`; the copies are gitignored because they are exactly the
// files of the locked onnxruntime-web version.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// Resolve the onnxruntime-web that transformers.js itself depends on.
const transformersDir = dirname(require.resolve('@huggingface/transformers/package.json'));
const ortRequire = createRequire(join(transformersDir, 'package.json'));
const ortDist = join(dirname(ortRequire.resolve('onnxruntime-web/package.json')), 'dist');

const FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

const available = new Set(readdirSync(ortDist));
const missing = FILES.filter((file) => !available.has(file));
if (missing.length > 0) {
  console.error(`copy-ort-wasm: ${ortDist} is missing ${missing.join(', ')}`);
  process.exit(1);
}

const target = join(process.cwd(), 'public', 'ort');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of FILES) copyFileSync(join(ortDist, file), join(target, file));
console.log(`copy-ort-wasm: ${FILES.length} files → public/ort/`);
