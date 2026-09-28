/**
 * Load Atlas portal data directly from the canonical GitHub markdown.
 *
 * This replaces the old Supabase pipeline:
 *   loadAtlasFromSupabase() → buildNotionAtlasTree() → notionTreeToExportTree()
 *
 * With the simpler:
 *   fetchAtlasMarkdownContent() → parseAtlasMarkdown()
 *
 * The markdown parser already produces ExportAtlasTreeScopeTrees — the same
 * type the portal UI expects. The only gap is UUID mappings: the old pipeline
 * mapped Notion page IDs ↔ Atlas UUIDs. Since we no longer have Notion page IDs,
 * we use identity mappings (atlas UUID → itself) so the UI components that use
 * uuidMappings for React keys and DOM IDs continue to work unchanged.
 *
 * BUILD-TIME VALIDATION: This module validates that the parser didn't silently
 * drop any documents. If the count of title lines in the raw markdown doesn't
 * match the count of nodes in the parsed tree, the build fails. This prevents
 * deploying a portal with missing documents.
 */
import { parseAtlasMarkdown } from './export/atlas-markdown-importer';
import { type ExportAtlasTreeBaseDocument, type ExportAtlasTreeDocument } from './export/types';
import type { ExportAtlasTreeScopeTrees } from './export/types';
import { childCollectionNames } from './export/types';
import { fetchAtlasMarkdownContent } from './load-atlas-tree-from-github';
import type { UuidMappings } from './load-uuid-mapping';

// Same regex used by the parser to identify document title lines
const HEADER_REGEX = /^(#+)\s+([^\s]+)\s+-\s+(.*?)\s+\[(.+?)\]\s+<!--\s*UUID:\s*([a-f0-9-]*)\s*-->\s*$/i;

/**
 * Recursively collect all UUIDs from an Export Tree document and its children.
 * Builds an identity map (uuid → uuid) since there are no Notion page IDs
 * in the GitHub-native pipeline.
 */
function collectUuids(node: ExportAtlasTreeDocument, map: Map<string, string>): void {
  const base = node as ExportAtlasTreeBaseDocument;
  if (base.uuid) {
    map.set(base.uuid, base.uuid);
  }

  for (const collName of childCollectionNames) {
    const children = (node as unknown as Record<string, unknown>)[collName];
    if (Array.isArray(children)) {
      for (const child of children as ExportAtlasTreeDocument[]) {
        collectUuids(child, map);
      }
    }
  }
}

/**
 * Count documents by type in the raw markdown by matching title lines.
 */
function countDocumentsInMarkdown(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of markdown.split('\n')) {
    const m = line.match(HEADER_REGEX);
    if (m) {
      const type = m[4];
      counts.set(type, (counts.get(type) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Count documents by type in the parsed Export Tree.
 */
function countDocumentsInTree(trees: ExportAtlasTreeScopeTrees): Map<string, number> {
  const counts = new Map<string, number>();

  function walk(node: ExportAtlasTreeDocument) {
    counts.set(node.type, (counts.get(node.type) || 0) + 1);
    for (const collName of childCollectionNames) {
      const children = (node as unknown as Record<string, unknown>)[collName];
      if (Array.isArray(children)) {
        for (const child of children as ExportAtlasTreeDocument[]) {
          walk(child);
        }
      }
    }
  }

  for (const tree of trees) walk(tree);
  return counts;
}

function totalCount(map: Map<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

/**
 * Validate that the parser produced exactly the same documents as exist
 * in the raw markdown. Throws on any mismatch — failing the build.
 */
function validateCompleteness(markdown: string, trees: ExportAtlasTreeScopeTrees): void {
  const rawCounts = countDocumentsInMarkdown(markdown);
  const treeCounts = countDocumentsInTree(trees);

  const rawTotal = totalCount(rawCounts);
  const treeTotal = totalCount(treeCounts);

  const allTypes = [...new Set([...rawCounts.keys(), ...treeCounts.keys()])].sort();
  const mismatches: string[] = [];

  for (const type of allTypes) {
    const raw = rawCounts.get(type) || 0;
    const parsed = treeCounts.get(type) || 0;
    if (raw !== parsed) {
      mismatches.push(
        `  ${type}: ${raw} in markdown, ${parsed} in tree (${parsed - raw > 0 ? '+' : ''}${parsed - raw})`,
      );
    }
  }

  if (mismatches.length > 0 || rawTotal !== treeTotal) {
    const error = [
      `Atlas build validation FAILED: document count mismatch.`,
      `Total: ${rawTotal} in markdown, ${treeTotal} in parsed tree.`,
      `Mismatches by type:`,
      ...mismatches,
    ].join('\n');
    throw new Error(error);
  }

  // Sanity floor: vacuous (0 == 0) should NOT pass. If upstream returns
  // empty markdown, the parsed tree is empty too, and a count comparison
  // alone matches by coincidence. Without this guard, a blank tree can be
  // cached and served. Threshold 1 catches the empty case without breaking
  // small-fixture tests; for production, the upstream composeFromTarball
  // byte check also fires at ~3.4 MB scale.
  const SANITY_FLOOR = 1;
  if (rawTotal < SANITY_FLOOR) {
    throw new Error(
      `Atlas build validation FAILED: only ${rawTotal} documents found in markdown ` +
        `(expected ≥ ${SANITY_FLOOR}). Upstream content fetch/extract likely returned ` +
        `partial or empty data.`,
    );
  }

  console.log(`[Atlas] Build validation passed: ${treeTotal} documents, ${allTypes.length} types, all counts match.`);
}

/**
 * Load Atlas data for the portal by fetching markdown from GitHub and parsing
 * it into the Export Tree format the UI expects.
 *
 * Validates completeness at build time — if any documents are silently dropped
 * by the parser, the build fails and the broken version never deploys.
 *
 * Returns the same shape as the old Supabase pipeline so the portal UI
 * (AtlasPagePrerendered, Sidebar, ContentTree, SearchModal) works unchanged.
 */
// SEARCH-86: parse once per corpus version per process. The GitHub path hands
// back the compose cache's own string, so the comparison short-circuits on
// reference equality; the override path compares content. Returning the SAME
// tree object for the same markdown is load-bearing: downstream per-tree memos
// (the answer route's context map) key on tree identity.
let parsedCache: {
  markdown: string;
  result: { exportScopeTrees: ExportAtlasTreeScopeTrees; uuidMappings: UuidMappings };
} | null = null;

export async function loadAtlasPortalData(): Promise<{
  exportScopeTrees: ExportAtlasTreeScopeTrees;
  uuidMappings: UuidMappings;
}> {
  const markdown = await fetchAtlasMarkdownContent();
  if (parsedCache && parsedCache.markdown === markdown) return parsedCache.result;

  const exportScopeTrees = parseAtlasMarkdown(markdown);

  // Validate: every document in the markdown must appear in the tree
  validateCompleteness(markdown, exportScopeTrees);

  // Build identity UUID mappings for UI compatibility
  const identityMap = new Map<string, string>();
  for (const tree of exportScopeTrees) {
    collectUuids(tree, identityMap);
  }

  const result = {
    exportScopeTrees,
    uuidMappings: {
      notionPageIDsToAtlasUUIDs: identityMap,
      atlasUUIDsToNotionPageIds: identityMap,
    },
  };
  parsedCache = { markdown, result };
  return result;
}

/** For tests: clear the parse cache. */
export function _clearAtlasPortalDataCache(): void {
  parsedCache = null;
}
