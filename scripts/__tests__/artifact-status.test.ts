import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allFresh, artifactCorpusHash, formatArtifactStatus, readArtifactStatus } from '../search-eval/artifact-status';

const CORPUS_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

let dir: string;
function writeArtifacts(overrides: Partial<Record<string, unknown>> = {}): string {
  dir = mkdtempSync(path.join(tmpdir(), 'artifact-status-'));
  const files: Record<string, unknown> = {
    'atlas-search-index.json': { corpusHash: CORPUS_HASH, documentCount: 11456, index: '{}' },
    'atlas-search-vectors.json': { corpusHash: CORPUS_HASH, count: 11456 },
    'atlas-search-vectors.bin': null, // raw bytes companion
    'atlas-search-families.json': { corpusHash: CORPUS_HASH, families: [['A.1', 'A.2']] },
    'atlas-abbreviations.json': { corpusHash: CORPUS_HASH, version: 2, entries: [{ acronym: 'ad' }] },
    'atlas-graph.json': { corpusHash: CORPUS_HASH, entities: { ad: [] } },
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue; // override with undefined = omit the file
    writeFileSync(
      path.join(dir, name),
      Buffer.isBuffer(content) ? content : content === null ? Buffer.from([0]) : JSON.stringify(content),
    );
  }
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('artifactCorpusHash', () => {
  it('hashes JSON.stringify of the parsed trees, not raw bytes', () => {
    const trees = [{ doc_no: 'A.0' }];
    expect(artifactCorpusHash(trees)).toBe(artifactCorpusHash(JSON.parse('[ {"doc_no" : "A.0"} ]')));
    expect(artifactCorpusHash(trees)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readArtifactStatus', () => {
  it('reports fresh across the board when every hash matches', () => {
    const rows = readArtifactStatus(CORPUS_HASH, writeArtifacts());
    expect(rows.map((row) => row.state)).toEqual(['fresh', 'fresh', 'fresh', 'fresh', 'fresh']);
    expect(allFresh(rows)).toBe(true);
  });

  it('reports stale with both hashes readable when the corpus moved', () => {
    const rows = readArtifactStatus(OTHER_HASH, writeArtifacts());
    expect(rows.every((row) => row.state === 'stale')).toBe(true);
    expect(rows[0].artifactHash).toBe(CORPUS_HASH);
    expect(allFresh(rows)).toBe(false);
  });

  it('flags one stale artifact among fresh ones (the family-map drift case)', () => {
    const rows = readArtifactStatus(
      CORPUS_HASH,
      writeArtifacts({ 'atlas-search-families.json': { corpusHash: OTHER_HASH, families: [] } }),
    );
    expect(rows.map((row) => row.state)).toEqual(['fresh', 'fresh', 'stale', 'fresh', 'fresh']);
    expect(rows[2].rebuild).toBe('npm run search:build-families');
  });

  it('reports missing files, invalid JSON, and a missing vector blob', () => {
    const rows = readArtifactStatus(
      CORPUS_HASH,
      writeArtifacts({
        'atlas-search-index.json': undefined,
        'atlas-search-vectors.bin': undefined,
        'atlas-search-families.json': 'not-json' as unknown,
      }),
    );
    expect(rows[0].state).toBe('missing');
    expect(rows[1].state).toBe('invalid'); // fresh manifest but absent blob
    expect(rows[1].detail).toContain('atlas-search-vectors.bin');
    expect(rows[2].state).toBe('invalid');
  });
});

describe('graph omitted by decision (no data shipped)', () => {
  it('reports the graph as omitted, not missing, when neither the artifact nor its data exist', () => {
    const noData = mkdtempSync(path.join(tmpdir(), 'graphrag-empty-'));
    const rows = readArtifactStatus(CORPUS_HASH, writeArtifacts({ 'atlas-graph.json': undefined }), {
      graphDataDir: noData,
    });
    expect(rows[4].state).toBe('omitted');
    expect(allFresh(rows)).toBe(true);
    expect(formatArtifactStatus(rows, CORPUS_HASH).join('\n')).toMatch(/omitted.*atlas-graph\.json.*Related/);
    rmSync(noData, { recursive: true, force: true });
  });

  it('a missing graph artifact with data present is still MISSING', () => {
    const withData = mkdtempSync(path.join(tmpdir(), 'graphrag-data-'));
    writeFileSync(path.join(withData, 'meta.json'), '{}');
    const rows = readArtifactStatus(CORPUS_HASH, writeArtifacts({ 'atlas-graph.json': undefined }), {
      graphDataDir: withData,
    });
    expect(rows[4].state).toBe('missing');
    expect(allFresh(rows)).toBe(false);
    rmSync(withData, { recursive: true, force: true });
  });
});

describe('vector blob binding (bug 13: torn writes)', () => {
  const blob = Buffer.from([1, 2, 3, 4]);
  const sha = createHash('sha256').update(blob).digest('hex');

  it('accepts a blob whose byte length and hash match the manifest', () => {
    const rows = readArtifactStatus(
      CORPUS_HASH,
      writeArtifacts({
        'atlas-search-vectors.json': { corpusHash: CORPUS_HASH, count: 1, blobBytes: 4, blobSha256: sha },
        'atlas-search-vectors.bin': blob as unknown,
      }),
    );
    expect(rows[1].state).toBe('fresh');
  });

  it('reports a blob whose byte length disagrees with the manifest as invalid', () => {
    const rows = readArtifactStatus(
      CORPUS_HASH,
      writeArtifacts({
        'atlas-search-vectors.json': { corpusHash: CORPUS_HASH, count: 1, blobBytes: 9, blobSha256: sha },
        'atlas-search-vectors.bin': blob as unknown,
      }),
    );
    expect(rows[1].state).toBe('invalid');
    expect(rows[1].detail).toMatch(/4 bytes.*9/);
  });

  it('reports a blob whose hash disagrees with the manifest as invalid', () => {
    const rows = readArtifactStatus(
      CORPUS_HASH,
      writeArtifacts({
        'atlas-search-vectors.json': { corpusHash: CORPUS_HASH, count: 1, blobBytes: 4, blobSha256: 'e'.repeat(64) },
        'atlas-search-vectors.bin': blob as unknown,
      }),
    );
    expect(rows[1].state).toBe('invalid');
    expect(rows[1].detail).toMatch(/sha256/i);
  });
});

describe('formatArtifactStatus', () => {
  it('names both hashes on a stale row and the rebuild command everywhere it matters', () => {
    const lines = formatArtifactStatus(readArtifactStatus(OTHER_HASH, writeArtifacts()), OTHER_HASH);
    const stale = lines.find((line) => line.includes('atlas-search-vectors.json'));
    expect(stale).toContain('STALE');
    expect(stale).toContain(CORPUS_HASH.slice(0, 12));
    expect(stale).toContain(OTHER_HASH.slice(0, 12));
    expect(stale).toContain('npm run search:build-vectors');
  });

  it('keeps fresh rows short', () => {
    const lines = formatArtifactStatus(readArtifactStatus(CORPUS_HASH, writeArtifacts()), CORPUS_HASH);
    expect(lines.filter((line) => line.includes('fresh'))).toHaveLength(5);
    expect(lines.join('\n')).toContain('11456 entries');
  });
});
