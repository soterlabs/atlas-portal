/**
 * SEARCH-58: result-list sections. The composed ranking is partitioned at its tier
 * boundaries into headed sections (≥2 categories), each truncated to its first 20
 * top-level rows behind a "Show all" reveal, with a sticky jump bar of per-section
 * counts. Single-category lists and browse mode stay flat.
 *
 * Provenance reaches the modal through the hybrid compose; with ≥10 strict hits the
 * confident branch composes synchronously without any dense backend, so a strict-rich
 * fixture exercises the sections with no vector mock. A thin-strict query in jsdom
 * (dense unavailable) falls back to the unlabeled flat list — also asserted below.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

// The fixture's documents are all siblings, which SEARCH-32's tree-backbone
// segmentation would collapse into one group; identity segmentation keeps every
// row visible so the sectioning itself is what gets asserted.
vi.mock('../segmentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../segmentation')>();
  return {
    ...actual,
    segmentCandidates: (candidates: unknown[]) => candidates,
    summarizeGroups: () => [],
  };
});

// Twelve documents match both words (strict tier, past the confident gate of 10);
// 25 match only "alpha" (relaxed tier).
const trees = [
  createDoc('Scope', 'C.1', 'Alpha Beta Rule', 'The alpha beta combination lives together here.', {
    articles: [
      ...Array.from({ length: 11 }, (_, index) =>
        createDoc(
          'Article',
          `C.1.${index + 1}`,
          `Alpha Beta Case ${index + 1}`,
          `Both alpha and beta appear ${index + 1}.`,
        ),
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        createDoc('Article', `C.1.${index + 12}`, `Alpha Note ${index + 1}`, `An alpha document number ${index + 1}.`),
      ),
    ],
  }),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
});

async function openWith(query: string) {
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, query);
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  return { user, input };
}

describe('SearchModal result sections (SEARCH-58)', () => {
  it('renders headed sections in tier order, truncated to 20 with Show all', async () => {
    const { user } = await openWith('alpha beta');

    const exactHeader = await screen.findByTestId('section-header-exact', {}, { timeout: 3000 });
    // SEARCH-68: the sectioned view has NO summary sentence — the
    // headers and jump bar carry the counts.
    expect(screen.queryByText(/Showing top \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/results — the strongest/)).not.toBeInTheDocument();
    expect(exactHeader.textContent).toContain('Exact matches (12)');
    expect(screen.getByTestId('section-header-partial').textContent).toContain('Partial matches (25)');

    // Caps (5 per category): first 5 of 12 exact + first 5 of 25 partials; the
    // ranking order is preserved — the strict rows come first.
    expect(screen.getAllByRole('option')).toHaveLength(10);
    const first = screen.getAllByRole('option')[0];
    expect(first.textContent).toContain('Alpha Beta');

    const showAllExact = screen.getByTestId('section-show-all-exact');
    expect(showAllExact.textContent).toContain('Show all 12 exact matches');
    const showAll = screen.getByTestId('section-show-all-partial');
    expect(showAll.textContent).toContain('Show all 25 partial matches');
    await user.click(showAll);
    expect(screen.getAllByRole('option')).toHaveLength(30);
    // SEARCH-74: the toggle stays and collapses back.
    expect(screen.getByTestId('section-show-all-partial').textContent).toBe('Show fewer');
    await user.click(screen.getByTestId('section-show-all-partial'));
    expect(screen.getAllByRole('option')).toHaveLength(10);
    await user.click(screen.getByTestId('section-show-all-partial'));
    await user.click(showAllExact);
    expect(screen.getAllByRole('option')).toHaveLength(37);

    // SEARCH-74: clicking a header collapses the whole category (header stays).
    await user.click(screen.getByTestId('section-header-partial'));
    expect(screen.getAllByRole('option')).toHaveLength(12);
    expect(screen.getByTestId('section-header-partial').textContent).toContain('Partial matches (25)');
    await user.click(screen.getByTestId('section-header-partial'));
    expect(screen.getAllByRole('option')).toHaveLength(37);
  });

  it('the jump bar lists per-section counts and scrolls to the section header', async () => {
    const { user } = await openWith('alpha beta');

    const bar = await screen.findByTestId('section-jump-bar', {}, { timeout: 3000 });
    expect(within(bar).getByTestId('section-jump-exact').textContent).toBe('Exact matches (12)');
    expect(within(bar).getByTestId('section-jump-partial').textContent).toBe('Partial matches (25)');

    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    await user.click(within(bar).getByTestId('section-jump-partial'));
    const calls = vi.mocked(Element.prototype.scrollIntoView).mock.calls;
    expect(calls.some((call) => (call[0] as ScrollIntoViewOptions | undefined)?.block === 'start')).toBe(true);
  });

  it('a single-category list keeps its header (the label IS the information) but no bar', async () => {
    const { user } = await openWith('alpha');
    await waitFor(() => expect(screen.getByTestId('section-show-all-exact')).toBeInTheDocument(), { timeout: 3000 });
    // SEARCH-74 follow-up: the header always shows; a one-chip jump bar stays hidden.
    expect(screen.getByTestId('section-header-exact').textContent).toContain('Exact matches (37)');
    expect(screen.queryByTestId('section-jump-bar')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    await user.click(screen.getByTestId('section-show-all-exact'));
    expect(screen.getAllByRole('option')).toHaveLength(37);
  });

  it('a thin-strict query with dense unavailable stays a flat unlabeled list', async () => {
    await openWith('together');
    await screen.findAllByRole('option');
    expect(screen.queryByTestId('section-jump-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-header-exact')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-show-all-exact')).not.toBeInTheDocument();
  });

  it('browse mode (no provenance) stays flat', async () => {
    await openWith('type:Scope');
    await screen.findAllByRole('option');
    expect(screen.queryByTestId('section-jump-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-header-exact')).not.toBeInTheDocument();
  });
});
