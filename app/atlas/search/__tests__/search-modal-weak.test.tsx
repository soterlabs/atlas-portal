/**
 * SEARCH-30: the out-of-vocabulary path in the modal — the "no exact matches" notice,
 * weak guesses hidden behind the reveal control, and provenance chips on semantic rows.
 *
 * The dense side is mocked: a real VectorStore over synthetic vectors plus a
 * deterministic embedder, so which document scores 1.0 (a similar match) and which
 * scores below HYBRID_RUNG_WEAK_SCORE (weak guesses) is under test control.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

// The reader's query embeds to e0. Document vectors are set so that doc row 0 is a
// clear semantic match (cosine 1.0) and rows 1-2 are weak guesses (0.55 and 0.0).
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
      const vectors = [Float32Array.from([1, 0]), Float32Array.from([0.55, 0.835]), Float32Array.from([0, 1])];
      const { manifest, blob } = actual.VectorStore.encode(vectors, {
        corpusHash: 'mocked',
        model: QUERY_EMBEDDING_MODEL.key,
        docNos: ['B.1', 'B.2', 'B.3'],
      });
      return actual.VectorStore.decode(manifest, blob);
    },
  };
});

/** Three documents whose text never contains the query word — an OOV query by design. */
function oovTree() {
  return [
    createDoc('Scope', 'B.1', 'Flagged Regions', 'Regions with restricted network access are listed here.', {
      articles: [
        createDoc('Article', 'B.2', 'Registry Overview', 'The registry lists covered service areas.'),
        createDoc('Article', 'B.3', 'Fee Schedule', 'Fees are settled quarterly.'),
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

describe('SearchModal out-of-vocabulary handling (SEARCH-30)', () => {
  it('shows the notice, hides weak guesses behind the reveal control, and labels provenance', async () => {
    render(<SearchModal scopeTrees={oovTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'plutonium');

    // The dense upgrade lands: the notice appears and only the strong guess renders.
    const notice = await screen.findByTestId('no-exact-matches');
    expect(notice.textContent).toContain('No exact matches for "plutonium"');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    // SEARCH-70: the strong similar row carries no chip — its section says it.
    expect(screen.queryAllByTestId('result-provenance')).toHaveLength(0);

    // Two weak guesses wait behind the control; revealing them labels them clearly.
    const toggle = screen.getByTestId('weak-matches-toggle');
    expect(toggle.textContent).toBe('2 weak matches hidden — show them');
    await user.click(toggle);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(
      screen
        .getAllByTestId('result-provenance')
        .map((chip) => chip.textContent)
        .filter((label) => label === 'weak match'),
    ).toHaveLength(2);

    // And they collapse again.
    await user.click(screen.getByTestId('weak-matches-toggle'));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('a revealed weak row keeps its dimming and its background classes separate (bug 1)', async () => {
    render(<SearchModal scopeTrees={oovTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'plutonium');
    await screen.findByTestId('no-exact-matches');
    await user.click(screen.getByTestId('weak-matches-toggle'));
    const weak = screen.getAllByRole('option').filter((option) => option.textContent?.includes('weak match'));
    expect(weak).toHaveLength(2);
    for (const row of weak) {
      expect(row).toHaveClass('opacity-70');
      expect(row).toHaveClass('dark:bg-zinc-800');
    }
  });

  it('never routes weak guesses into the top-10 the answer feature reads', async () => {
    render(<SearchModal scopeTrees={oovTree()} isOpen onClose={vi.fn()} answersEnabled />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'plutonium');
    await screen.findByTestId('no-exact-matches');
    await waitFor(() => expect(screen.getByTestId('weak-matches-toggle')).toBeInTheDocument());

    // The reveal changes rendering only — the visible strong list stays the sole
    // result row, so answers can only ever see it.
    await user.click(screen.getByTestId('weak-matches-toggle'));
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Flagged Regions');
  });
});
