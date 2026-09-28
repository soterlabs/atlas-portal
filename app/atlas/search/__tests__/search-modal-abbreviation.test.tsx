/**
 * SEARCH-55: the abbreviation notice and chip in the modal. The artifact loader is
 * mocked with a one-entry table (crr → capital ratio requirement); the dense mock
 * keeps the rung weak-hidden so the expanded route is what fills the page.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

vi.mock('../abbreviation-artifact', () => ({
  tryLoadAbbreviations: async () =>
    new Map([['crr', { acronym: 'crr', phrases: ['capital ratio requirement'], source: 'parenthetical' as const }]]),
}));

vi.mock('../query-embedder', () => ({
  LocalQueryEmbedder: class {
    async embed(): Promise<Float32Array> {
      return Float32Array.from([1, 0]);
    }
  },
}));

// Dense artifacts absent: the plain keyword path carries the expanded rows — the
// deterministic setup; the hybrid interaction is pinned by the engine tests.
vi.mock('../vector-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector-store')>();
  return { ...actual, tryLoadVectorStore: async () => null };
});

function abbreviationTree() {
  return [
    createDoc('Scope', 'B.1', 'Stability', 'Solvency rules are defined per instance.', {
      articles: [
        createDoc('Core', 'B.2', 'Capital Ratio Requirement', 'The capital ratio requirement governs solvency.'),
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

describe('SearchModal abbreviation expansion (SEARCH-55)', () => {
  it('surfaces phrase documents for an acronym query, with notice and chip', async () => {
    render(<SearchModal scopeTrees={abbreviationTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'crr');

    const notice = await screen.findByTestId('atlas-abbreviation-notice', {}, { timeout: 3000 });
    expect(notice.textContent).toContain('“CRR” → “capital ratio requirement”');

    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.some((option) => option.textContent?.includes('Capital Ratio Requirement'))).toBe(true);
    });
    const chips = screen.getAllByTestId('result-provenance');
    expect(chips.map((chip) => chip.textContent)).toContain('abbreviation');
  });

  it('shows no notice when the literal query already matches', async () => {
    render(<SearchModal scopeTrees={abbreviationTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'capital ratio');

    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.some((option) => option.textContent?.includes('Capital Ratio Requirement'))).toBe(true);
    });
    expect(screen.queryByTestId('atlas-abbreviation-notice')).toBeNull();
  });
});
