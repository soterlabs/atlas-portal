#!/usr/bin/env node
/**
 * CLI: are the committed search artifacts fresh for the corpus this branch would serve?
 * (SEARCH-49 — the check half; the eval runner prints the same status inline.)
 *
 * Usage:
 *   npm run search:check-artifacts                          # against the live corpus
 *   npm run search:check-artifacts -- <corpus-url-or-path>  # against a specific corpus
 *
 * Exit 0 with a per-artifact "fresh" line when everything matches; exit 1 naming both
 * hashes and the rebuild command for every stale, missing, or invalid artifact. A CI
 * pipeline gets the whole gate by running this one script; until the fork has a
 * pipeline, it is the pre-release / pre-merge manual check.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { allFresh, artifactCorpusHash, formatArtifactStatus, readArtifactStatus } from './search-eval/artifact-status';

export const DEFAULT_CORPUS_URL = 'https://sky-atlas.io/api/atlas.json';

async function loadCorpus(source: string): Promise<unknown> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? DEFAULT_CORPUS_URL;
  console.log(`Corpus: ${source}`);
  const trees = await loadCorpus(source);
  const corpusHash = artifactCorpusHash(trees);
  const documents = Array.isArray(trees) ? trees.length : undefined;
  console.log(`Corpus hash ${corpusHash}${documents !== undefined ? ` (${documents} trees)` : ''}\n`);

  const rows = readArtifactStatus(corpusHash);
  for (const line of formatArtifactStatus(rows, corpusHash)) console.log(line);

  if (!allFresh(rows)) {
    console.error(
      '\nThe Atlas has moved since these artifacts were built. A deployed branch in this state ' +
        'silently degrades: stale index → in-browser build without expansions, stale vectors → ' +
        'dense rung disabled, stale family map → collapse and family-aware rung selection disabled. ' +
        'Rebuild with the commands above (each takes the corpus URL or path as its argument), commit, rerun. ' +
        'A graph reported as omitted (no data/graphrag on this tree) is not a failure.',
    );
    process.exit(1);
  }
  console.log('\nAll artifacts fresh.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
