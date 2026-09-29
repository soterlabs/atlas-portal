#!/usr/bin/env node
/**
 * CLI: build the prebuilt document vectors (SEARCH-19) and write
 * `public/atlas-search-vectors.json` (manifest) + `public/atlas-search-vectors.bin`
 * (u8-dim quantised blob) — the dense rung's counterpart of the prebuilt keyword index.
 *
 * Embeds the SEARCH-18 winner: bge-small @ q8 over the un-expanded retrieval document
 * (expansion text measurably dilutes dense embeddings — SEARCH-18 round 2). The manifest
 * records the corpus hash; the browser verifies it against its own tree and silently
 * skips the dense rung on any mismatch. Our team owns when this runs (D3), alongside
 * `search:build-index`.
 *
 * Usage:
 *   npx tsx scripts/build-search-vectors.ts [corpus-url-or-path]
 *     # default http://localhost:3000/api/atlas.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import { type VectorManifest, VectorStore } from '../app/atlas/search/vector-store';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';
import { embedPassagesIncremental } from './embedding-eval/embed';
import { type ModelSpec, modelByKey } from './embedding-eval/models';
import { buildEmbeddedText } from './embedding-eval/text-variants';

export const MANIFEST_PATH = 'public/atlas-search-vectors.json';
export const BLOB_PATH = 'public/atlas-search-vectors.bin';

/** Write to a sibling temp file, then rename: a crash never leaves a half-written artifact. */
function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/** The model every artifact row is embedded with; changing it requires a rebuild. */
export const VECTOR_MODEL_KEY = 'bge-small';

/**
 * Embeds the corpus incrementally (D3, mirroring the expansion store): vectors are
 * cached per document, keyed by the SHA-256 of the embedded text, so a small Atlas diff
 * re-embeds only the changed documents. The packed artifact is still re-emitted in
 * full — row order and the u8 quantisation statistics are whole-corpus properties.
 */
async function embedDocumentsIncremental(spec: ModelSpec, texts: string[]): Promise<Float32Array[]> {
  const { vectors, embedded } = await embedPassagesIncremental(spec, texts, `doc-vectors-${spec.key}`);
  console.log(`Embeddings: ${texts.length - embedded} from the document cache, ${embedded} embedded.`);
  return vectors;
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? 'http://localhost:3000/api/atlas.json';
  console.log(`Loading corpus from ${source} …`);
  const corpusText = source.startsWith('http') ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const scopeTrees = JSON.parse(corpusText) as ExportAtlasTreeDocument[];

  // The same string the browser hashes: JSON.stringify of the parsed tree.
  const corpusHash = createHash('sha256').update(JSON.stringify(scopeTrees)).digest('hex');

  const documents = flattenAtlasDocuments(scopeTrees);
  const spec = modelByKey(VECTOR_MODEL_KEY);
  const texts = documents.map((doc) => buildEmbeddedText(doc, 'retrieval-doc-no-expansion'));

  const start = performance.now();
  const vectors = await embedDocumentsIncremental(spec, texts);
  const embedMs = performance.now() - start;

  const { manifest, blob } = VectorStore.encode(vectors, {
    corpusHash,
    model: spec.key,
    docNos: documents.map((doc) => doc.doc_no),
  });

  const blobBuffer = Buffer.from(blob);
  const bound: VectorManifest = {
    ...manifest,
    blobBytes: blobBuffer.byteLength,
    blobSha256: createHash('sha256').update(blobBuffer).digest('hex'),
  };
  // Blob first, manifest last: the manifest is the commit point and names the blob it expects.
  writeFileAtomic(BLOB_PATH, blobBuffer);
  writeFileAtomic(MANIFEST_PATH, JSON.stringify(bound));

  const manifestMb = JSON.stringify(bound).length / 1e6;
  console.log(`Embedded ${documents.length} documents in ${(embedMs / 1000).toFixed(1)} s (cache-aware).`);
  console.log(
    `Wrote ${BLOB_PATH}: ${(blob.byteLength / 1e6).toFixed(2)} MB (+ manifest ${manifestMb.toFixed(2)} MB), corpus ${corpusHash.slice(0, 12)}…`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
