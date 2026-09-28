/**
 * SEARCH-22 shipping: the duplicate-family map — membership, the "also under"
 * accessor, the corpus-hash-guarded loader, and the adopted collapse policy as a
 * selection stage (keep highest-ranked; later members dropped; singletons untouched).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_MAP_VERSION, FamilyMap, collapseSelection, tryLoadFamilyMap } from '../family-map';
import { corpusHash } from '../prebuilt-index';

const FAMILIES = [
  ['A.1', 'A.2', 'A.3'],
  ['B.1', 'B.2'],
];

describe('FamilyMap', () => {
  const map = new FamilyMap(FAMILIES);

  it('maps members to one shared family id and everything else to itself', () => {
    expect(map.familyOf('A.2')).toBe(map.familyOf('A.3'));
    expect(map.familyOf('A.1')).not.toBe(map.familyOf('B.1'));
    expect(map.familyOf('C.9')).toBe('C.9');
  });

  it('lists the other members for "also under" rendering', () => {
    expect(map.membersOf('A.2')).toEqual(['A.1', 'A.3']);
    expect(map.membersOf('C.9')).toEqual([]);
  });
});

describe('collapseSelection', () => {
  const map = new FamilyMap(FAMILIES);
  const docNos = ['A.1', 'B.1', 'A.2', 'C.9', 'B.2', 'A.3'];
  const stage = collapseSelection(
    (docNo) => map.familyOf(docNo),
    (id) => docNos[id],
  );

  it('keeps the highest-ranked member of each family and every singleton', () => {
    const candidates = docNos.map((_, id) => ({ id }));
    expect(stage(candidates).map((hit) => docNos[hit.id])).toEqual(['A.1', 'B.1', 'C.9']);
  });

  it('is the identity when no candidates share a family', () => {
    const candidates = [{ id: 0 }, { id: 1 }, { id: 3 }];
    expect(stage(candidates)).toEqual(candidates);
  });
});

describe('tryLoadFamilyMap', () => {
  const scopeTrees = [{ doc_no: 'A.0', name: 'root' }];

  function stubFetch(artifact: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(artifact)),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('loads a matching artifact', async () => {
    const hash = await corpusHash(scopeTrees);
    stubFetch({ version: FAMILY_MAP_VERSION, corpusHash: hash, definition: 'embedding-cosine', families: FAMILIES });
    const map = await tryLoadFamilyMap(scopeTrees);
    expect(map).not.toBeNull();
    expect(map!.familyOf('B.2')).toBe('B.1');
  });

  it('returns null on a hash mismatch, wrong version, malformed artifact, or fetch failure', async () => {
    stubFetch({ version: FAMILY_MAP_VERSION, corpusHash: 'f'.repeat(64), families: FAMILIES });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await tryLoadFamilyMap(scopeTrees)).toBeNull();
    // SEARCH-49: the staleness line names both hashes so the remedy is obvious.
    const message = String(info.mock.calls.at(-1)?.[0] ?? '');
    expect(message).toContain('ffffffffffff');
    expect(message).toContain((await corpusHash(scopeTrees))?.slice(0, 12) ?? 'NO-HASH');
    expect(message).toContain('search:check-artifacts');
    info.mockRestore();

    const hash = await corpusHash(scopeTrees);
    stubFetch({ version: 999, corpusHash: hash, families: FAMILIES });
    expect(await tryLoadFamilyMap(scopeTrees)).toBeNull();

    stubFetch({ hello: 'world' });
    expect(await tryLoadFamilyMap(scopeTrees)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await tryLoadFamilyMap(scopeTrees)).toBeNull();
  });
});
