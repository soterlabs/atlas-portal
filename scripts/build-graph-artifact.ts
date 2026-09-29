#!/usr/bin/env node
/**
 * CLI: derive the compact GraphRAG artifact (SEARCH-59) from the raw knowledge-graph
 * contract files in `data/graphrag/` and write `public/atlas-graph.json`. Corpus-hash
 * pinned like every artifact; the browser silently skips a stale one. Run alongside
 * the other artifact builders on corpus updates (D3) — after regenerating the raw KG
 * files themselves, which are pinned to the same Atlas snapshot.
 *
 * Usage:
 *   npx tsx scripts/build-graph-artifact.ts [corpus-url-or-path] [graphrag-dir]
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flattenAtlasDocuments } from '../app/atlas/search/flatten-documents';
import { type GraphRawFiles, buildGraphArtifact } from '../app/atlas/search/graph-artifact';
import type { ExportAtlasTreeDocument } from '../app/server/atlas/export/types';

const OUT_PATH = 'public/atlas-graph.json';

async function main(): Promise<void> {
  const source = process.argv[2] ?? 'http://localhost:3000/api/atlas.json';
  const graphDir = process.argv[3] ?? 'data/graphrag';

  console.log(`Loading corpus from ${source} …`);
  const corpusText = source.startsWith('http') ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const scopeTrees = JSON.parse(corpusText) as ExportAtlasTreeDocument[];
  const documents = flattenAtlasDocuments(scopeTrees);

  console.log(`Loading raw KG files from ${graphDir} …`);
  const raw: GraphRawFiles = {
    meta: JSON.parse(readFileSync(join(graphDir, 'meta.json'), 'utf8')),
    sections: JSON.parse(readFileSync(join(graphDir, 'sections.json'), 'utf8')),
    entities: JSON.parse(readFileSync(join(graphDir, 'entities.json'), 'utf8')),
    mentions: JSON.parse(readFileSync(join(graphDir, 'mentions.json'), 'utf8')),
    edges: JSON.parse(readFileSync(join(graphDir, 'edges.json'), 'utf8')),
    relations: JSON.parse(readFileSync(join(graphDir, 'relations.json'), 'utf8')),
  };
  if (raw.meta.schema_version !== 2) {
    throw new Error(`unknown KG schema_version ${raw.meta.schema_version} (this builder codes against v2)`);
  }

  const pinnedCorpusHash = createHash('sha256').update(JSON.stringify(scopeTrees)).digest('hex');
  const { artifact, report } = buildGraphArtifact(raw, documents, pinnedCorpusHash);

  writeFileSync(OUT_PATH, `${JSON.stringify(artifact)}\n`);
  const bytes = statSync(OUT_PATH).size;
  console.log(
    `Wrote ${OUT_PATH}: ${(bytes / 1024 / 1024).toFixed(2)} MB, ` +
      `atlas ${artifact.atlasVersion}, corpus ${pinnedCorpusHash.slice(0, 12)}…`,
  );
  console.log(
    `  entities ${report.entities} · aliases ${report.aliases} ` +
      `(${report.aliasCollisionsDropped.length} ambiguous surfaces dropped) · ` +
      `postings ${report.postingsRows}`,
  );
  console.log(
    `  typed edges ${report.typedKept} across ${report.typedRelations.length} relations ` +
      `(top: ${report.typedRelations
        .slice(0, 8)
        .map(([r, n]) => `${r}×${n}`)
        .join(' ')})`,
  );
  console.log(
    `  references ${report.references} · co-mentions ${report.coMentions} ` +
      `(${report.coMentionsDroppedBelowWeight} below weight threshold)`,
  );
  console.log(
    `  opposites ${report.opposites} · oppositional relation wordings ${report.oppositionalRelations} (DP-GR8)`,
  );
  console.log(
    `  canonical vocabulary ${report.canonicalRelations} relations · aspect facts ${report.aspects} (DP-GR9..11)`,
  );
  if (report.uncoveredDocuments > 0) {
    console.log(
      `  ${report.uncoveredDocuments} corpus documents have no graph section (added after the graph was generated) — regenerate the graph data to cover them`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
