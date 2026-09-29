/**
 * SEARCH-66: the list may auto-scroll only for keyboard selection. Hover
 * selection fires constantly while the USER scrolls (rows slide under the
 * stationary cursor), so a hover-driven scrollIntoView hijacks the scroll —
 * the bug found while testing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

// All fixture articles share one parent; identity segmentation keeps every row
// visible so the selection indices are what the test names.
vi.mock('../segmentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../segmentation')>();
  return { ...actual, segmentCandidates: (candidates: unknown[]) => candidates, summarizeGroups: () => [] };
});

const trees = [
  createDoc('Scope', 'E.1', 'Budget Scope', 'The budget scope body.', {
    articles: Array.from({ length: 12 }, (_, index) =>
      createDoc('Article', `E.1.${index + 1}`, `Budget Rule ${index + 1}`, `Budget rule number ${index + 1}.`),
    ),
  }),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
});

async function openAndSearch() {
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, 'budget');
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  // Wait for the hybrid upgrade to settle (the sectioned view appears), so the
  // row elements queried below are the live ones, not the replaced keyword list.
  await waitFor(() => expect(screen.getByTestId('section-show-all-exact')).toBeInTheDocument(), {
    timeout: 3000,
  });
  return { user, input };
}

describe('SearchModal selection scrolling (SEARCH-66)', () => {
  it('hover moves the highlight but never scrolls the list', async () => {
    const { user } = await openAndSearch();
    // 5-per-category cap: reveal the section so rows 3 and 5 exist.
    await user.click(screen.getByTestId('section-show-all-exact'));
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    fireEvent.mouseEnter(screen.getAllByRole('option')[3]);
    await waitFor(() => expect(screen.getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.mouseEnter(screen.getAllByRole('option')[5]);
    await waitFor(() => expect(screen.getAllByRole('option')[5]).toHaveAttribute('aria-selected', 'true'));

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keyboard selection scrolls the selected row into view', async () => {
    const { user, input } = await openAndSearch();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    input.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('a new query brings the top of the results into view', async () => {
    const { user, input } = await openAndSearch();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    await user.clear(input);
    await user.type(input, 'budget rule');
    await screen.findAllByRole('option');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });
});
