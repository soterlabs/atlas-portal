/**
 * Artifact freshness as a visible status (SEARCH-49).
 *
 * The browser's five prebuilt artifacts are all corpus-hash gated and all fail SILENTLY
 * to a degraded mode: a stale index falls back to the in-browser build (no expansions),
 * stale vectors disable the dense rung, a stale family map disables collapse — which is
 * load-bearing since SEARCH-44 made family-aware rung selection the default — a stale
 * abbreviation table stops acronym expansion and the two-capital lookups, and a stale
 * graph turns off the Related section, suggestion chips and definition answers. This module
 * gives every runner and check one shared answer to "do the committed artifacts match
 * this corpus?", naming both hashes so the remedy is obvious from the output alone
 * (the pattern the release branch's package-release.ts established).
 *
 * Hash convention (a documented past trap): artifacts are keyed to the SHA-256 of
 * `JSON.stringify(parsedTrees)` — NOT of the raw corpus bytes, which search-eval also
 * hashes for report identity. Compute the corpus hash with `artifactCorpusHash`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ArtifactState = 'fresh' | 'stale' | 'missing' | 'invalid' | 'omitted';

export interface ArtifactStatusRow {
  file: string;
  state: ArtifactState;
  /** The artifact's own corpus hash, when one could be read. */
  artifactHash?: string;
  /** Documents / vectors / families the artifact carries, when readable. */
  count?: number;
  /** The command that regenerates this artifact. */
  rebuild: string;
  /** Extra detail for invalid states. */
  detail?: string;
}

/** The hash artifacts are keyed to: SHA-256 hex of `JSON.stringify(parsedTrees)`. */
export function artifactCorpusHash(scopeTrees: unknown): string {
  return createHash('sha256').update(JSON.stringify(scopeTrees)).digest('hex');
}

interface ArtifactSpec {
  file: string;
  rebuild: string;
  /** Reads the artifact's corpus hash and payload count from its parsed JSON. */
  read: (parsed: Record<string, unknown>) => { hash: unknown; count: unknown };
  /** Companion file that must exist alongside a fresh artifact (the vector blob). */
  companion?: string;
  /** Checks the companion against what the manifest recorded; a string is the failure detail. */
  verifyCompanion?: (parsed: Record<string, unknown>, companionPath: string) => string | undefined;
  /** When true for an absent artifact, it is "omitted" (feature off by decision), not missing. */
  omittedWhenAbsent?: (options: { graphDataDir: string }) => boolean;
}

const SPECS: ArtifactSpec[] = [
  {
    file: 'atlas-search-index.json',
    rebuild: 'npm run search:build-index',
    read: (parsed) => ({ hash: parsed.corpusHash, count: parsed.documentCount }),
  },
  {
    file: 'atlas-search-vectors.json',
    rebuild: 'npm run search:build-vectors',
    read: (parsed) => ({ hash: parsed.corpusHash, count: parsed.count }),
    companion: 'atlas-search-vectors.bin',
    // The build records the blob's byte length and hash in the manifest; a crash between
    // the two writes, or a git mishap on the binary, must never read as fresh.
    verifyCompanion: (parsed, companionPath) => {
      const bytes = statSync(companionPath).size;
      if (typeof parsed.blobBytes === 'number' && parsed.blobBytes !== bytes) {
        return `atlas-search-vectors.bin is ${bytes} bytes; manifest records ${parsed.blobBytes} (torn write?)`;
      }
      if (typeof parsed.blobSha256 === 'string') {
        const sha = createHash('sha256').update(readFileSync(companionPath)).digest('hex');
        if (sha !== parsed.blobSha256) return 'atlas-search-vectors.bin sha256 does not match the manifest';
      }
      return undefined;
    },
  },
  {
    file: 'atlas-search-families.json',
    rebuild: 'npm run search:build-families',
    read: (parsed) => ({
      hash: parsed.corpusHash,
      count: Array.isArray(parsed.families) ? parsed.families.length : undefined,
    }),
  },
  // SEARCH-85: the two previously unwatched hash-pinned artifacts.
  {
    file: 'atlas-abbreviations.json',
    rebuild: 'npm run search:build-abbreviations',
    read: (parsed) => ({
      hash: parsed.corpusHash,
      count: Array.isArray(parsed.entries) ? parsed.entries.length : undefined,
    }),
  },
  {
    file: 'atlas-graph.json',
    rebuild: 'npm run search:build-graph-artifact (a restructured Atlas first needs regenerated data/graphrag)',
    read: (parsed) => ({
      hash: parsed.corpusHash,
      count: parsed.entities && typeof parsed.entities === 'object' ? Object.keys(parsed.entities).length : undefined,
    }),
    // No graph data on this tree means the graph features are off by decision (the data
    // is produced by a separate pipeline and may ship later), never a broken deploy.
    omittedWhenAbsent: ({ graphDataDir }) => !existsSync(path.join(graphDataDir, 'meta.json')),
  },
];

/** Status of every committed artifact in `dir` against the given corpus hash. */
export function readArtifactStatus(
  corpusHash: string,
  dir: string = 'public',
  options: { graphDataDir?: string } = {},
): ArtifactStatusRow[] {
  const graphDataDir = options.graphDataDir ?? 'data/graphrag';
  return SPECS.map((spec) => {
    const filePath = path.join(dir, spec.file);
    const base = { file: spec.file, rebuild: spec.rebuild };
    if (!existsSync(filePath)) {
      if (spec.omittedWhenAbsent?.({ graphDataDir })) {
        return {
          ...base,
          state: 'omitted' as const,
          detail: 'no graph data shipped — the Related section, suggestion chips and definition answers are off',
        };
      }
      return { ...base, state: 'missing' as const };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ...base, state: 'invalid' as const, detail: 'not valid JSON' };
    }
    const { hash, count } = spec.read(parsed);
    if (typeof hash !== 'string' || hash.length === 0) {
      return { ...base, state: 'invalid' as const, detail: 'no corpus hash recorded' };
    }
    const row: ArtifactStatusRow = {
      ...base,
      artifactHash: hash,
      count: typeof count === 'number' ? count : undefined,
      state: hash === corpusHash ? 'fresh' : 'stale',
    };
    if (row.state === 'fresh' && spec.companion && !existsSync(path.join(dir, spec.companion))) {
      return { ...row, state: 'invalid', detail: `${spec.companion} is absent` };
    }
    if (row.state === 'fresh' && spec.companion && spec.verifyCompanion) {
      const detail = spec.verifyCompanion(parsed, path.join(dir, spec.companion));
      if (detail) return { ...row, state: 'invalid', detail };
    }
    return row;
  });
}

/** True when every artifact is fresh; an artifact omitted by decision does not count against it. */
export function allFresh(rows: ArtifactStatusRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.state === 'fresh' || row.state === 'omitted');
}

const short = (hash: string | undefined): string => (hash ? `${hash.slice(0, 12)}…` : 'n/a');

/**
 * Human-readable status block. Both hashes are always named on a mismatch so the remedy
 * is obvious from the failure alone.
 */
export function formatArtifactStatus(rows: ArtifactStatusRow[], corpusHash: string): string[] {
  const lines = [`Artifacts vs corpus ${short(corpusHash)}:`];
  const width = Math.max(...rows.map((row) => row.file.length));
  for (const row of rows) {
    const name = row.file.padEnd(width);
    if (row.state === 'fresh') {
      lines.push(`  fresh    ${name}  (hash matches${row.count !== undefined ? `, ${row.count} entries` : ''})`);
    } else if (row.state === 'stale') {
      lines.push(
        `  STALE    ${name}  (artifact ${short(row.artifactHash)} ≠ corpus ${short(corpusHash)}) — rebuild: ${row.rebuild}`,
      );
    } else if (row.state === 'missing') {
      lines.push(`  MISSING  ${name}  — build: ${row.rebuild}`);
    } else if (row.state === 'omitted') {
      lines.push(`  omitted  ${name}  (${row.detail})`);
    } else {
      lines.push(`  INVALID  ${name}  (${row.detail ?? 'unreadable'}) — rebuild: ${row.rebuild}`);
    }
  }
  return lines;
}
