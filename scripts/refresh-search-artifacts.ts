#!/usr/bin/env node
/**
 * SEARCH-85: the weekly artifact refresh — one command after Atlas updates.
 *
 *   npm run search:refresh-artifacts
 *
 * Composes the current Atlas from GitHub (GITHUB_TOKEN from .env.local), runs
 * every artifact builder against that one snapshot, verifies all five
 * hash-pinned artifacts, and prints a plain report: upstream commit, corpus
 * hash, per-artifact status, how many documents lack expansions (reported,
 * never regenerated — that spend is an explicit opt-in), and the graph verdict.
 *
 * The graph is the one artifact the portal cannot refresh alone: when the
 * Atlas restructured (graph-only section ids), the build refuses, the graph
 * stays pinned, and this script says so loudly — the other artifacts refresh
 * regardless, and the exit code stays 0 for that one tolerated case. Any
 * other stale artifact after the run exits 1.
 *
 * After a clean run: commit the refreshed artifacts and open a pull request —
 * staleness is bounded by the cadence. (A scheduled pipeline can run this on a timer.)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';
import { artifactCorpusHash, formatArtifactStatus, readArtifactStatus } from './search-eval/artifact-status';
import { documentKey, expansionMap, loadStore } from './search-expansion/store';

/** tsx does not load .env.local (Next.js only does for its own processes). */
function loadEnvLocal(): void {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, raw] = match;
      if (process.env[key] === undefined) process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
}

function run(label: string, args: string[]): { ok: boolean; output: string } {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync('npx', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  return { ok: result.status === 0, output };
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('=== Snapshot: composing the current Atlas from GitHub ===');
  const { loadAtlasMarkdownFromGitHub } = await import('../app/server/atlas/load-atlas-tree-from-github');
  const { parseAtlasMarkdown } = await import('../app/server/atlas/export/atlas-markdown-importer');
  const snapshot = await loadAtlasMarkdownFromGitHub();
  const trees = parseAtlasMarkdown(snapshot.content) as ExportAtlasTreeDocument[];
  const corpusHash = artifactCorpusHash(trees);
  const corpusPath = path.join(mkdtempSync(path.join(tmpdir(), 'atlas-refresh-')), 'corpus.json');
  writeFileSync(corpusPath, JSON.stringify(trees));
  console.log(
    `  upstream ${snapshot.commitSha.slice(0, 12)} (${snapshot.lastModified.toISOString()}) — ` +
      `corpus ${corpusHash.slice(0, 12)}…, ${flattenAtlasDocuments(trees).length} documents`,
  );

  const failures: string[] = [];
  const step = (label: string, script: string, extra: string[] = []) => {
    if (!run(label, ['tsx', script, corpusPath, ...extra]).ok) failures.push(label);
  };
  step('Census (cosine families input)', 'scripts/duplicate-census.ts', [
    '--out',
    'data/duplicate-census.json',
    '--cosine',
  ]);
  step('Family map', 'scripts/build-search-families.ts');
  step('Prebuilt index', 'scripts/build-search-index.ts');
  step('Document vectors (incremental)', 'scripts/build-search-vectors.ts');
  step('Abbreviations (curation applied)', 'scripts/build-abbreviations.ts');

  // The graph needs its source data. Without data/graphrag the graph is OMITTED by
  // decision (features off, reported), never a failure. With data: rebuild when it
  // still matches; a restructured Atlas is the tolerated, loudly-reported exception —
  // regeneration happens in the knowledge-graph pipeline.
  const graphOmitted = !existsSync('data/graphrag/meta.json');
  const graph = graphOmitted
    ? { ok: true, output: '' }
    : run('Graph artifact', ['tsx', 'scripts/build-graph-artifact.ts', corpusPath]);
  const graphPinned = !graph.ok && /graph-only ids/.test(graph.output);
  if (!graph.ok && !graphPinned) failures.push('Graph artifact');

  if (failures.length > 0) {
    console.error(`\nRefresh FAILED at: ${failures.join(', ')} — nothing was verified; fix and rerun.`);
    process.exit(1);
  }

  // Expansions are never regenerated here (paid API — explicit opt-in);
  // report how many documents currently carry none.
  const bare = flattenAtlasDocuments(trees);
  const expansions = expansionMap(bare, loadStore());
  const unexpanded = bare.filter((document) => !expansions[documentKey(document)]).length;

  console.log('\n=== Verify ===');
  const rows = readArtifactStatus(corpusHash);
  for (const line of formatArtifactStatus(rows, corpusHash)) console.log(line);

  const graphRow = rows.find((row) => row.file === 'atlas-graph.json');
  const blockers = rows.filter(
    (row) => row.state !== 'fresh' && row.state !== 'omitted' && !(row === graphRow && graphPinned),
  );

  console.log('\n=== Report ===');
  console.log(`  upstream commit   ${snapshot.commitSha.slice(0, 12)} (${snapshot.lastModified.toISOString()})`);
  console.log(`  corpus hash       ${corpusHash.slice(0, 12)}…`);
  console.log(`  without expansion ${unexpanded} of ${bare.length} documents (top-up is a paid, on-request step)`);
  console.log(
    graphOmitted
      ? '  graph             OMITTED (no data/graphrag shipped; Related section, suggestion chips and definition answers off)'
      : graphPinned
        ? `  graph             PINNED at ${graphRow?.artifactHash?.slice(0, 12) ?? 'n/a'}… — the Atlas restructured; ` +
          `regenerate data/graphrag with the knowledge-graph pipeline, then rerun. Related section, suggestion chips and ` +
          `definition answers stay off until then.`
        : `  graph             fresh`,
  );

  if (blockers.length > 0) {
    console.error(`\n${blockers.length} artifact(s) still stale after the refresh — see above.`);
    process.exit(1);
  }
  console.log(
    graphPinned
      ? '\nRefresh complete (graph pinned, tolerated). Commit the refreshed artifacts and open a pull request.'
      : '\nRefresh complete. (In a build these artifacts ship with the deployment; they are not committed.)',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
