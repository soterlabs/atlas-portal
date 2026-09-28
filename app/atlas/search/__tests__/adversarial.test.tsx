import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildSnippet, splitHighlight } from '../highlight';
import { buildSearchIndexSync, searchAtlas, tokenizeField, tokenizeQuery } from '../search-index';
import SearchModal from '../search-modal';
import { useAtlasSearch } from '../use-atlas-search';
import { RECENT_SEARCHES_KEY, useRecentSearches } from '../use-recent-searches';
import { createDoc, createFixtureTree } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ADVERSARIAL: degenerate corpora', () => {
  it('survives an empty corpus end-to-end', () => {
    const docs = flattenAtlasDocuments([]);
    expect(docs).toEqual([]);
    const index = buildSearchIndexSync(docs);
    expect(searchAtlas(index, 'anything')).toEqual({ hits: [], total: 0 });
  });

  it('renders with an empty corpus without crashing', async () => {
    render(<SearchModal scopeTrees={[]} isOpen onClose={vi.fn()} />);
    expect(await screen.findByPlaceholderText('Search Atlas documents...')).toBeInTheDocument();
  });

  it('handles a deeply nested tree without blowing the stack', () => {
    let node: ExportAtlasTreeDocument = createDoc('Section', 'A.1'.padEnd(4, '1'), 'leaf', 'deep leaf');
    for (let i = 0; i < 2000; i++) {
      node = createDoc('Section', `A.${i}`, `level ${i}`, 'x', { sections_and_primary_docs: [node] });
    }
    const docs = flattenAtlasDocuments([node]);
    expect(docs).toHaveLength(2001);
    expect(docs[docs.length - 1].depth).toBe(2000);
  });

  it('handles a document whose fields are empty strings', () => {
    const docs = flattenAtlasDocuments([createDoc('Scope', 'A.9', '', '')]);
    const index = buildSearchIndexSync(docs);
    expect(searchAtlas(index, 'a.9').hits.map((h) => docs[h.id].doc_no)).toEqual(['A.9']);
  });
});

describe('ADVERSARIAL: injection', () => {
  it('renders HTML in document fields as inert text', async () => {
    const user = userEvent.setup();
    const evil = createDoc('Scope', 'A.99', '<img src=x onerror=alert(1)>pwn', '<script>alert(2)</script> budget');
    render(<SearchModal scopeTrees={[evil]} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    const opt = (await screen.findAllByRole('option'))[0];
    expect(opt.querySelector('img')).toBeNull();
    expect(opt.querySelector('script')).toBeNull();
    expect(opt.textContent).toContain('pwn');
  });

  it('does not let a crafted query act as a regex', () => {
    // A term that would be catastrophic if interpolated unescaped.
    const segs = splitHighlight('aaaaaaaaaaaaaaaaaaaaaaaaX', ['(a+)+$']);
    expect(segs).toEqual([{ text: 'aaaaaaaaaaaaaaaaaaaaaaaaX', match: false }]);
  });

  it('survives a very large term list in highlighting', () => {
    const terms = Array.from({ length: 5000 }, (_, i) => `term${i}`);
    const t0 = performance.now();
    const segs = splitHighlight('term42 and term4999 appear here', terms);
    const ms = performance.now() - t0;
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['term42', 'term4999']);
    expect(ms).toBeLessThan(1000);
  });
});

describe('ADVERSARIAL: degenerate arguments', () => {
  it('buildSnippet tolerates hostile lengths', () => {
    expect(buildSnippet('hello world', ['world'], 0)).toBeTypeOf('string');
    expect(buildSnippet('hello world', ['world'], -5)).toBeTypeOf('string');
    expect(buildSnippet('', ['x'], 150)).toBe('');
    expect(buildSnippet('abc', [], 2)).toBeTypeOf('string');
  });

  it('tokenizers tolerate hostile input', () => {
    const huge = 'a'.repeat(200_000);
    expect(() => tokenizeField(huge, 'content')).not.toThrow();
    expect(() => tokenizeField(huge, 'doc_no')).not.toThrow();
    expect(tokenizeQuery('.'.repeat(1000))).toEqual([]);
    expect(tokenizeField('', 'doc_no')).toEqual([]);
    expect(tokenizeField('   ', 'doc_no')).toEqual([]);
  });

  it('searchAtlas tolerates a zero limit and an unknown type filter', () => {
    const docs = flattenAtlasDocuments(createFixtureTree());
    const index = buildSearchIndexSync(docs);
    const zero = searchAtlas(index, 'budget', { limit: 0 });
    expect(zero.hits).toEqual([]);
    expect(zero.total).toBeGreaterThan(0);
    expect(searchAtlas(index, 'budget', { types: ['Nonexistent Type'] })).toEqual({ hits: [], total: 0 });
  });
});

describe('ADVERSARIAL: storage', () => {
  it('ignores non-string entries and over-long history', () => {
    window.localStorage.setItem(
      RECENT_SEARCHES_KEY,
      JSON.stringify([1, null, 'ok', { a: 1 }, 'two', 'three', 'four', 'five', 'six']),
    );
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents.every((r) => typeof r === 'string')).toBe(true);
    expect(result.current.recents.length).toBeLessThanOrEqual(5);
  });

  it('recovers when storage holds a JSON object instead of an array', () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify({ not: 'an array' }));
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recents).toEqual([]);
  });
});

describe('ADVERSARIAL: lifecycle', () => {
  it('does not warn or throw when unmounted mid-build', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trees = createFixtureTree();
    const { unmount } = renderHook(() => useAtlasSearch(trees));
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keyboard actions are inert when there are no results', async () => {
    const user = userEvent.setup();
    render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'zzzzzzzznothing');
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('aria-activedescendant always names a live element while results exist', async () => {
    const user = userEvent.setup();
    render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

    for (let i = 0; i < 8; i++) {
      await user.keyboard('{ArrowDown}');
      const ad = input.getAttribute('aria-activedescendant');
      expect(ad).toBeTruthy();
      expect(document.getElementById(ad!)).not.toBeNull();
    }
    // Now narrow the result set and confirm the selection re-anchors.
    await user.click(screen.getByRole('button', { name: 'Filter by Scope' }));
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));
    const ad = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(ad!)).not.toBeNull();
    expect(within(screen.getAllByRole('option')[0]).getByText('A.2')).toBeInTheDocument();
  });
});
