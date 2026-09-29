#!/usr/bin/env node
/**
 * CLI: build the duplicate-family artifact (SEARCH-22 shipping) from the committed
 * census (`data/duplicate-census.json`) and write `public/atlas-search-families.json` — the browser side of
 * the adopted collapse policy (cosine families collapse to the highest-ranked member).
 *
 * Refuses a census that was generated from a different corpus: the census is keyed by
 * the corpus text's SHA-256, and shipping families for the wrong corpus would collapse
 * the wrong documents. Run after `duplicate-census.ts --cosine` on corpus updates,
 * alongside the index and vector builds (D3).
 *
 * Usage:
 *   npx tsx scripts/build-search-families.ts [corpus-url-or-path]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { FAMILY_MAP_VERSION, type FamilyMapArtifact } from '../app/atlas/search/family-map';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';

const CENSUS_PATH = 'data/duplicate-census.json';
export const ARTIFACT_PATH = 'public/atlas-search-families.json';

interface CensusFile {
  corpus: { sha256: string };
  census: { embeddingCosine?: { threshold: number; families: Array<{ docNos: string[] }> } };
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? 'http://localhost:3000/api/atlas.json';
  console.log(`Loading corpus from ${source} …`);
  const corpusText = source.startsWith('http') ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const trees = JSON.parse(corpusText) as ExportAtlasTreeDocument[];

  const census = JSON.parse(readFileSync(CENSUS_PATH, 'utf8')) as CensusFile;
  const rawHash = createHash('sha256').update(corpusText).digest('hex');
  if (census.corpus.sha256 !== rawHash) {
    throw new Error(
      `census corpus ${census.corpus.sha256.slice(0, 12)}… does not match this corpus ${rawHash.slice(0, 12)}… — regenerate with duplicate-census.ts --cosine`,
    );
  }
  const cosine = census.census.embeddingCosine;
  if (!cosine) throw new Error('census lacks the embedding-cosine arm (rerun with --cosine)');

  const artifact: FamilyMapArtifact = {
    version: FAMILY_MAP_VERSION,
    // The same string the browser hashes: JSON.stringify of the parsed tree.
    corpusHash: createHash('sha256').update(JSON.stringify(trees)).digest('hex'),
    definition: 'embedding-cosine',
    cosineThreshold: cosine.threshold,
    families: cosine.families.map((family) => [...family.docNos].sort()),
  };
  const serialized = JSON.stringify(artifact);
  writeFileSync(ARTIFACT_PATH, serialized);
  const documents = artifact.families.reduce((sum, family) => sum + family.length, 0);
  console.log(
    `Wrote ${ARTIFACT_PATH}: ${(serialized.length / 1024).toFixed(0)} KB — ${artifact.families.length} families, ${documents} documents, corpus ${artifact.corpusHash.slice(0, 12)}…`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
