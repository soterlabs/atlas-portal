#!/usr/bin/env node
/**
 * CLI: harvest the corpus-derived abbreviation table (SEARCH-55) and write
 * `public/atlas-abbreviations.json`. Corpus-hash pinned like every artifact; the
 * browser silently skips a stale table. Run alongside the other artifact builders
 * on corpus updates (D3).
 *
 * Usage:
 *   npx tsx scripts/build-abbreviations.ts [corpus-url-or-path]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AbbreviationArtifact } from '../app/atlas/search/abbreviation-artifact';
import { type AbbreviationCuration, applyCuration, harvestAbbreviations } from '../app/atlas/search/abbreviations';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';

const OUT_PATH = 'public/atlas-abbreviations.json';
/** SEARCH-82: the tracked, hand-reviewed corrections applied on top of the harvest. */
const CURATION_PATH = 'data/abbreviation-curation.json';

async function main(): Promise<void> {
  const source = process.argv[2] ?? 'http://localhost:3000/api/atlas.json';
  console.log(`Loading corpus from ${source} …`);
  const corpusText = source.startsWith('http') ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const scopeTrees = JSON.parse(corpusText) as ExportAtlasTreeDocument[];
  const documents = flattenAtlasDocuments(scopeTrees);
  const curation = JSON.parse(readFileSync(CURATION_PATH, 'utf8')) as AbbreviationCuration;
  const table = applyCuration(harvestAbbreviations(documents), curation);

  const artifact: AbbreviationArtifact = {
    version: 2,
    corpusHash: createHash('sha256').update(JSON.stringify(scopeTrees)).digest('hex'),
    entries: [...table.values()].sort((a, b) => a.acronym.localeCompare(b.acronym)),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  const bySource = { parenthetical: 0, 'name-initialism': 0, curated: 0 };
  for (const entry of artifact.entries) bySource[entry.source] += 1;
  console.log(
    `Wrote ${OUT_PATH}: ${artifact.entries.length} entries ` +
      `(${bySource.parenthetical} parenthetical, ${bySource['name-initialism']} grounded initialisms, ` +
      `${bySource.curated} curated — ${(curation.exclude ?? []).length} excluded), ` +
      `corpus ${artifact.corpusHash.slice(0, 12)}…`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
