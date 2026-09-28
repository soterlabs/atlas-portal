#!/usr/bin/env node
/**
 * CLI: build the prebuilt search index (SEARCH-17) and write it to
 * `public/atlas-search-index.json`, where the browser loads it instead of rebuilding the
 * index on every page load. The artifact records the corpus hash it was
 * built from; the browser verifies that hash against its own document tree and falls
 * back to the in-browser build on any mismatch, so a stale artifact can never misalign
 * result ids.
 *
 * Usage:
 *   npx tsx scripts/build-search-index.ts [corpus-url]   # default http://localhost:3000/api/atlas.json
 *
 * Run after `scripts/search-expansion/generate.ts`; the committed expansion store is
 * folded into the index as the `expansion` field. Our team owns when this runs (D3).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import { PREBUILT_INDEX_VERSION, type PrebuiltIndexArtifact } from '../app/atlas/search/prebuilt-index';
import { buildSearchIndexSync } from '../app/atlas/search/search-index';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';
import { expansionMap, loadStore } from './search-expansion/store';

export const ARTIFACT_PATH = 'public/atlas-search-index.json';

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'http://localhost:3000/api/atlas.json';
  console.log(`Fetching corpus from ${url} …`);
  let corpusText: string;
  if (url.startsWith('http')) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
    corpusText = await response.text();
  } else {
    corpusText = readFileSync(url, 'utf8');
  }
  const scopeTrees = JSON.parse(corpusText) as ExportAtlasTreeDocument[];

  // The same string the browser hashes: JSON.stringify of the parsed tree, so formatting
  // differences in transit cannot cause spurious mismatches.
  const corpusHash = createHash('sha256').update(JSON.stringify(scopeTrees)).digest('hex');

  const store = loadStore();
  const bare = flattenAtlasDocuments(scopeTrees);
  const expansions = expansionMap(bare, store);
  const documents = flattenAtlasDocuments(scopeTrees, expansions);

  const start = performance.now();
  const index = buildSearchIndexSync(documents);
  const buildMs = performance.now() - start;

  const artifact: PrebuiltIndexArtifact = {
    version: PREBUILT_INDEX_VERSION,
    corpusHash,
    documentCount: documents.length,
    expandedCount: Object.keys(expansions).length,
    index: JSON.stringify(index),
  };
  const serialized = JSON.stringify(artifact);
  writeFileSync(ARTIFACT_PATH, serialized);

  console.log(
    `Built ${documents.length} documents (${artifact.expandedCount} with expansions) in ${buildMs.toFixed(0)} ms.`,
  );
  console.log(`Wrote ${ARTIFACT_PATH}: ${(serialized.length / 1e6).toFixed(2)} MB, corpus ${corpusHash.slice(0, 12)}…`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
