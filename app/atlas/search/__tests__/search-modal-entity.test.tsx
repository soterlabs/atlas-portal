/**
 * SEARCH-52: the entity disambiguation bar — trigger, per-chip counts, and rewrites.
 *
 * The dense side is mocked (the weak-test pattern): the rung retrieves the Sparkle
 * vault document for the entity+concept query, which is the thin-strict signal the
 * bar's trigger requires.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

vi.mock('../query-embedder', () => ({
  LocalQueryEmbedder: class {
    async embed(): Promise<Float32Array> {
      return Float32Array.from([1, 0]);
    }
  },
}));

vi.mock('../vector-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector-store')>();
  const { QUERY_EMBEDDING_MODEL } = await import('../embedding-model');
  return {
    ...actual,
    tryLoadVectorStore: async () => {
      // Flatten order: B.1, B.2 (agent root), B.2.1 Sparkle, B.2.1.1 vault, B.3.
      // The vault embeds at [1,0] so the mocked query retrieves it as the rung hit.
      const off = Float32Array.from([0, 1]);
      const vectors = [off, off, off, Float32Array.from([1, 0]), off];
      const { manifest, blob } = actual.VectorStore.encode(vectors, {
        corpusHash: 'mocked',
        model: QUERY_EMBEDDING_MODEL.key,
        docNos: ['B.1', 'B.2', 'B.2.1', 'B.2.1.1', 'B.3'],
      });
      return actual.VectorStore.decode(manifest, blob);
    },
  };
});

function entityTree() {
  return [
    createDoc('Scope', 'B.1', 'Governance Scope', 'The scope body.', {
      articles: [
        createDoc('Core', 'B.2', 'List Of Prime Agent Artifacts', 'The agents are listed here.', {
          articles: [
            createDoc('Core', 'B.2.1', 'Sparkle', 'An agent document.', {
              articles: [createDoc('Core', 'B.2.1.1', 'Savings Vault', 'Vault yields accrue daily.')],
            }),
          ],
        }),
        createDoc('Article', 'B.3', 'Checklist Guide', 'The checklist steps live here.'),
      ],
    }),
  ];
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('SearchModal entity disambiguation (SEARCH-52)', () => {
  it('fires on entity+concept with counts, and a chip rewrites the query', async () => {
    render(<SearchModal scopeTrees={entityTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'sparkle checklist');

    const bar = await screen.findByTestId('entity-disambiguation');
    expect(bar.textContent).toContain('Sparkle is an Atlas agent');
    const chips = screen.getAllByTestId('entity-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      '“checklist” within Sparkle (0)', // no checklist exists under Sparkle — the teaching count
      '“checklist” everywhere (1)',
      'about Sparkle (2)',
    ]);

    await user.click(chips[1]);
    expect((input as HTMLInputElement).value).toBe('checklist');
    await waitFor(() => expect(screen.queryByTestId('entity-disambiguation')).toBeNull());
    await waitFor(
      () => {
        const options = screen.getAllByRole('option');
        expect(options.some((option) => option.textContent?.includes('Checklist Guide'))).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('the within-chip rewrites onto the in: operator', async () => {
    render(<SearchModal scopeTrees={entityTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'sparkle checklist');
    await screen.findByTestId('entity-disambiguation');

    await user.click(screen.getAllByTestId('entity-chip')[0]);
    expect((input as HTMLInputElement).value).toBe('in:B.2.1 checklist');
  });

  it('stays silent on entity-only and concept-only queries', async () => {
    render(<SearchModal scopeTrees={entityTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');

    await user.type(input, 'sparkle');
    // findByText held a reference across the async dense-upgrade re-render: it could
    // resolve a keyword-pass row that the upgrade swap then detached before
    // toBeInTheDocument ran (flaky ~1 in 3). waitFor re-queries on every retry, so it
    // converges on the settled list instead of racing it.
    await waitFor(() => expect(screen.getAllByText('Sparkle').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByTestId('entity-disambiguation')).toBeNull();

    await user.clear(input);
    await user.type(input, 'checklist steps');
    await waitFor(
      () => {
        const options = screen.getAllByRole('option');
        expect(options.some((option) => option.textContent?.includes('Checklist Guide'))).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(screen.queryByTestId('entity-disambiguation')).toBeNull();
  });
});
