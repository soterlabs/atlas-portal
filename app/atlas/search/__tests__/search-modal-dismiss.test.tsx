/**
 * SEARCH-75: the window closes only via the X button or a click outside it —
 * selecting text in a result never navigates, and Escape never dismisses.
 * SEARCH-78: Enter in the search field only updates the results or does
 * nothing — it opens a row only after an arrow-key selection.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const trees = [createDoc('Scope', 'G.1', 'Budget Rules', 'The budget rules body.')];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openAndSearch(onClose = vi.fn()) {
  render(<SearchModal scopeTrees={trees} isOpen onClose={onClose} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, 'budget');
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  await screen.findAllByRole('option');
  return { user, onClose };
}

describe('SearchModal dismissal (SEARCH-75)', () => {
  it('a click that ends a text selection never navigates or closes', async () => {
    const { onClose } = await openAndSearch();
    vi.stubGlobal('getSelection', () => ({ toString: () => 'copied text' }));
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0); // still open
  });

  it('a plain row click still navigates (and closes)', async () => {
    const { onClose } = await openAndSearch();
    fireEvent.click(screen.getAllByRole('option')[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Escape does not dismiss the window', async () => {
    const { user, onClose } = await openAndSearch();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Enter in the search field (SEARCH-78)', () => {
  it('Enter right after typing does nothing — no navigation, no close', async () => {
    const { user, onClose } = await openAndSearch();
    await user.keyboard('{Enter}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0); // still open
  });

  it('hovering a row does not arm Enter', async () => {
    const { user, onClose } = await openAndSearch();
    fireEvent.mouseEnter(screen.getAllByRole('option')[0]);
    await user.keyboard('{Enter}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an arrow-key selection arms Enter: the chosen row opens and the window closes', async () => {
    const { user, onClose } = await openAndSearch();
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
