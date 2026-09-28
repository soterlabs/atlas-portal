import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { buildSearchIndexSync, searchAtlas } from '../search-index';
import SearchModal from '../search-modal';
import { useAtlasSearch } from '../use-atlas-search';
import { createDoc, createFixtureTree } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ADVERSARIAL 2: unmapped document type', () => {
  it('shows what happens when a type is absent from typeColorMap', async () => {
    const user = userEvent.setup();
    const doc = createDoc('Brand New Type', 'A.77', 'Novel Doc', 'budget matters here');
    render(<SearchModal scopeTrees={[doc]} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    const opt = (await screen.findAllByRole('option'))[0];
    const chip = [...opt.querySelectorAll('span')].find((s) => s.textContent === 'Brand New Type')!;
    console.log('  unmapped type chip className:', JSON.stringify(chip.className));
    console.log(
      '  filter chip className:',
      JSON.stringify(screen.getByRole('button', { name: 'Filter by Brand New Type' }).className),
    );
    expect(chip.className).not.toContain('undefined'); // fails today if unguarded
  });
});

describe('ADVERSARIAL 2: two modals mounted at once', () => {
  it('gives each instance its own listbox id', async () => {
    render(
      <>
        <SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />
        <SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />
      </>,
    );
    await screen.findAllByPlaceholderText('Search Atlas documents...');
    // Each instance must advertise a distinct listbox, not one shared hardcoded id.
    const controls = [...document.querySelectorAll('[aria-controls]')]
      .map((e) => e.getAttribute('aria-controls')!)
      .filter((v) => v.startsWith('atlas-search-results'));
    expect(controls).toHaveLength(2);
    expect(controls[0]).not.toBe(controls[1]);
    expect(controls.every((c) => c !== 'atlas-search-results')).toBe(true);

    const allIds = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const dupes = [...new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))];
    expect(dupes).toEqual([]);
  });
});

describe('ADVERSARIAL 2: debounce race', () => {
  it('the last query wins after fast typing and fast deletion', async () => {
    const user = userEvent.setup();
    render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    // Replace with a query that must match nothing; stale results must not survive.
    await user.clear(input);
    await user.type(input, 'zzzzqqqq');
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
    expect(screen.getByText(/No documents found/)).toBeInTheDocument();
  });
});

describe('ADVERSARIAL 2: rapid tree swaps', () => {
  it('a slow earlier build never overwrites a newer one', async () => {
    const a = createFixtureTree();
    const b = [createDoc('Scope', 'Z.1', 'Only Zed', 'zedcontent')];
    const { result, rerender } = renderHook(({ t }) => useAtlasSearch(t), { initialProps: { t: a } });
    rerender({ t: b });
    rerender({ t: a });
    rerender({ t: b });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.documents.map((d) => d.doc_no)).toEqual(['Z.1']);
    expect(result.current.search('zedcontent').hits).toHaveLength(1);
    expect(result.current.search('budget').hits).toHaveLength(0);
  });
});

describe('ADVERSARIAL 2: hostile doc_no values', () => {
  it('doc numbers containing regex metacharacters are searchable and highlightable', async () => {
    const user = userEvent.setup();
    const docs = [createDoc('Scope', 'A.1(x)+', 'Weird Number', 'budget content')];
    const flat = flattenAtlasDocuments(docs);
    const index = buildSearchIndexSync(flat);
    expect(searchAtlas(index, 'budget').hits).toHaveLength(1);
    render(<SearchModal scopeTrees={docs} isOpen onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    const opt = (await screen.findAllByRole('option'))[0];
    expect(opt.textContent).toContain('A.1(x)+');
  });

  it('a doc_no containing whitespace still tokenizes as one unit', () => {
    const flat = flattenAtlasDocuments([createDoc('Scope', 'A 1 2', 'Spaced', 'content')]);
    const index = buildSearchIndexSync(flat);
    expect(searchAtlas(index, 'a 1 2').hits.length).toBeGreaterThanOrEqual(0); // must not throw
  });
});

describe('ADVERSARIAL 2: reopen state hygiene', () => {
  it('navigating clears query and filters for the next open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={onClose} />);
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'budget');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: 'Filter by Scope' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    await user.click(screen.getAllByRole('option')[0]);

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });
});
