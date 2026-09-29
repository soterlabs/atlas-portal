#!/usr/bin/env node
/**
 * CLI: Duplicate census of the Atlas corpus (SEARCH-16).
 *
 * Usage:
 *   npx tsx scripts/duplicate-census.ts [corpus-url] [--out <census.json>] [--cosine]
 *
 * --cosine adds definition 4 (embedding cosine ≥ 0.98, SEARCH-18's bge-small vectors,
 * cached under node_modules/.cache/embedding-eval; first run embeds ~2 min).
 *
 * Defaults to http://localhost:3000/api/atlas.json (any served copy of the live
 * corpus works). Prints the summary tables and, with --out, writes the full
 * machine-readable census keyed by the corpus SHA-256 (the families build reads
 * `data/duplicate-census.json`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';
import { type Census, type FamilySetSummary, buildCensus, crossCheckFamily } from './duplicate-census/census';
import { GRADED_QUERIES } from './search-eval/graded-queries';

interface CensusArtifact {
  generatedAt: string;
  corpus: { url: string; documents: number; sha256: string };
  census: Census;
}

function parseArguments(argv: string[]): { url: string; outputPath?: string; withCosine: boolean } {
  let url = 'http://localhost:3000/api/atlas.json';
  let outputPath: string | undefined;
  let withCosine = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      outputPath = argv[index + 1];
      if (!outputPath) throw new Error('--out requires a file path');
      index += 1;
    } else if (argument === '--cosine') {
      withCosine = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option ${argument}`);
    } else {
      url = argument;
    }
  }
  return { url, outputPath, withCosine };
}

function formatDistribution(distribution: Record<number, number>): string {
  return Object.entries(distribution)
    .map(([size, count]) => [Number(size), count] as const)
    .sort((left, right) => left[0] - right[0])
    .map(([size, count]) => `${size}:${count}`)
    .join('  ');
}

function printSummary(label: string, summary: FamilySetSummary): void {
  console.log(`\n${label}`);
  console.log(`  families ${summary.families}  documents ${summary.documents}`);
  console.log(`  size distribution   ${formatDistribution(summary.sizeDistribution)}`);
  console.log(
    `  documents by type   ${Object.entries(summary.documentsByType)
      .sort((left, right) => right[1] - left[1])
      .map(([type, count]) => `${type}:${count}`)
      .join('  ')}`,
  );
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  console.log(`Fetching corpus from ${options.url} …`);
  let corpusJson: string;
  if (options.url.startsWith('http')) {
    const response = await fetch(options.url);
    if (!response.ok) throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
    corpusJson = await response.text();
  } else {
    corpusJson = readFileSync(options.url, 'utf8');
  }
  const sha256 = createHash('sha256').update(corpusJson).digest('hex');
  const scopeTrees = JSON.parse(corpusJson) as ExportAtlasTreeDocument[];

  const documents = flattenAtlasDocuments(scopeTrees);
  console.log(`Flattened ${documents.length} indexable documents.`);
  console.log(`Corpus SHA-256 ${sha256}`);

  const uniqueDocNos = new Set(documents.map((doc) => doc.doc_no));
  if (uniqueDocNos.size !== documents.length) {
    throw new Error(
      `Corpus violates the doc_no uniqueness invariant: ${documents.length - uniqueDocNos.size} collision(s).`,
    );
  }
  console.log('doc_no uniqueness: every flattened document has a distinct doc_no.');

  let cosine: { model: string; vectors: Float32Array[] } | undefined;
  if (options.withCosine) {
    const { embedPassagesIncremental } = await import('./embedding-eval/embed');
    const { modelByKey } = await import('./embedding-eval/models');
    const { buildEmbeddedText } = await import('./embedding-eval/text-variants');
    const spec = modelByKey('bge-small');
    // Cached per document body (text hash), so a rebuild after a small Atlas change
    // re-embeds only the changed bodies — this runs on every deploy.
    console.log(`Embedding bodies with ${spec.key} for definition 4 (incremental cache) …`);
    const { vectors, embedded } = await embedPassagesIncremental(
      spec,
      documents.map((doc) => buildEmbeddedText(doc, 'body')),
      `census-body-${spec.key}`,
    );
    console.log(`  ${documents.length - embedded} bodies from the cache, ${embedded} embedded.`);
    cosine = { model: spec.key, vectors };
  }

  const startedAt = performance.now();
  const census = buildCensus(documents, cosine);
  console.log(`Census computed in ${((performance.now() - startedAt) / 1000).toFixed(1)} s.`);

  console.log(`\nEmpty bodies: ${census.emptyBodies}`);
  printSummary('Identical normalised body (definition 1)', census.identicalBody.summary);
  printSummary(`Identical body, ≥ 200 chars ("substantial" subset)`, census.identicalBodySubstantial.summary);
  printSummary(
    `Near-duplicate: exact Jaccard ≥ ${census.nearDuplicate.threshold} over word ` +
      `${census.nearDuplicate.shingleSize}-shingles, ≥ ${census.nearDuplicate.minWords} words (definition 2)`,
    census.nearDuplicate.summary,
  );
  printSummary('Same name + same parent name (template families, definition 3a)', census.sameNameSameParent.summary);
  printSummary('Same name across different parents (definition 3b)', census.sameNameMixedParent.summary);
  if (census.embeddingCosine) {
    printSummary(
      `Embedding cosine ≥ ${census.embeddingCosine.threshold} (${census.embeddingCosine.model}, ` +
        `≥ ${census.embeddingCosine.minWords} words, definition 4)`,
      census.embeddingCosine.summary,
    );
    console.log(
      `  pair counts by threshold   ${Object.entries(census.embeddingCosine.pairCounts)
        .map(([t, n]) => `≥${t}: ${n}`)
        .join('  ')}`,
    );
  }

  console.log('\nLargest substantial identical-body families:');
  for (const family of census.identicalBodySubstantial.families.slice(0, 10)) {
    console.log(
      `  ×${family.docNos.length}  ${family.name ?? '(mixed names)'}  (${family.bodyChars} chars)  ${family.docNos[0]}`,
    );
  }

  console.log('\nSEARCH-15 duplicate-family judgments vs census:');
  for (const query of GRADED_QUERIES.filter((entry) => entry.class === 'duplicate-family')) {
    const judged = query.judgments.flatMap((judgment) => (judgment.grade > 0 ? judgment.docNos : []));
    const check = crossCheckFamily(query.id, judged, census);
    console.log(`  ${check.queryId} matched by: ${check.matchedBy.join(', ') || 'nothing'}`);
    const clip = (docNos: string[]): string =>
      docNos.length <= 8 ? docNos.join(' ') : `${docNos.slice(0, 8).join(' ')} … (+${docNos.length - 8} more)`;
    if (check.missingFromJudged.length > 0) {
      console.log(
        `    census members missing from the judgment (${check.missingFromJudged.length}): ${clip(check.missingFromJudged)}`,
      );
    }
    if (check.judgedNotInCensusFamily.length > 0) {
      console.log(`    judged members in no census family: ${clip(check.judgedNotInCensusFamily)}`);
    }
  }

  if (options.outputPath) {
    const artifact: CensusArtifact = {
      generatedAt: new Date().toISOString(),
      corpus: { url: options.url, documents: documents.length, sha256 },
      census,
    };
    await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`\nWrote census to ${options.outputPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
