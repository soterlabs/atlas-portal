/**
 * SEARCH-67: the maximize/restore toggle — button, double-click on the header,
 * persistence alongside the remembered size, and drag-to-restore.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const trees = [createDoc('Scope', 'F.1', 'Rules', 'The rules body.')];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

const storedState = (): { width?: number; height?: number; maximized?: boolean } =>
  JSON.parse(window.localStorage.getItem('atlas-search-modal-size') ?? '{}');

describe('SearchModal maximize toggle (SEARCH-67)', () => {
  it('the button maximizes, persists the state, and restores on a second click', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const toggle = await screen.findByTestId('modal-maximize-toggle');
    expect(toggle).toHaveAttribute('aria-label', 'Maximize window');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-label', 'Restore window size');
    expect(storedState().maximized).toBe(true);
    // The bug caught in browser testing: the style must ALSO defeat the
    // HeroUI shell's own max-height, or the window stays capped ~120px short.
    const content = toggle.closest('section') as HTMLElement;
    expect(content.style.height).toBe('100dvh');
    expect(content.style.maxHeight).toBe('none');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-label', 'Maximize window');
    expect(storedState().maximized).toBe(false);
  });

  it('a stored maximized state is restored on open', async () => {
    window.localStorage.setItem(
      'atlas-search-modal-size',
      JSON.stringify({ width: 700, height: 500, maximized: true }),
    );
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const toggle = await screen.findByTestId('modal-maximize-toggle');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-label', 'Restore window size'));
  });

  it('double-clicking the header toggles, but double-clicking the input never does', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const toggle = await screen.findByTestId('modal-maximize-toggle');
    const header = await screen.findByTestId('search-modal-header');

    fireEvent.doubleClick(header);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-label', 'Restore window size'));

    const input = screen.getByPlaceholderText('Search Atlas documents...');
    fireEvent.doubleClick(input);
    expect(toggle).toHaveAttribute('aria-label', 'Restore window size'); // unchanged

    fireEvent.doubleClick(header);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-label', 'Maximize window'));
  });

  it('dragging a resize edge while maximized leaves maximized mode', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const toggle = await screen.findByTestId('modal-maximize-toggle');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-label', 'Restore window size');

    const handle = screen.getByTestId('resize-handle-e');
    fireEvent.pointerDown(handle, { clientX: 800, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 400 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-label', 'Maximize window'));
    expect(storedState().maximized).toBe(false);
  });
});
