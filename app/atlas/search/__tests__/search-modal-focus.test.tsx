import { useEffect } from 'react';
import { useDisclosure } from '@heroui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchShortcutHandler } from '../../search-shortcuts';
import SearchTrigger from '../../search-trigger';
import SearchModal from '../search-modal';
import { createFixtureTree } from './fixtures';

const trees = createFixtureTree();

function SearchHarness() {
  const { isOpen, onOpen, onClose } = useDisclosure();

  useEffect(() => {
    const handleKeyDown = createSearchShortcutHandler(onOpen);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpen]);

  return (
    <>
      <button type="button">Outside search</button>
      <SearchTrigger onOpen={onOpen} />
      <SearchModal scopeTrees={trees} isOpen={isOpen} onClose={onClose} />
    </>
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('SearchModal initial focus', () => {
  it.each(['click', '{Control>}k{/Control}', '{Meta>}k{/Meta}', '/'])(
    'accepts typing immediately after opening with %s, including on reopen',
    async (opener) => {
      const user = userEvent.setup();
      render(<SearchHarness />);

      for (let opening = 0; opening < 2; opening++) {
        if (opener === 'click') {
          await user.click(screen.getByRole('textbox', { name: 'Open search dialog (CMD+K or Ctrl+K)' }));
        } else {
          // Start with focus outside the dialog, as happens when browsing the Atlas.
          await user.click(screen.getByRole('button', { name: 'Outside search' }));
          await user.keyboard(opener);
        }

        const input = await screen.findByRole('combobox');
        await waitFor(() => expect(input).toHaveFocus());
        expect(input).toHaveValue(opening === 0 ? '' : 'budget');
        // keyboard() never clicks/focuses the input on our behalf.
        await user.keyboard('{Control>}a{/Control}budget');
        expect(input).toHaveValue('budget');
        await screen.findAllByRole('option');

        await user.click(screen.getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      }
    },
  );

  it('lets the user move focus to search tools without pulling it back', async () => {
    const user = userEvent.setup();
    render(<SearchHarness />);
    await user.click(screen.getByRole('textbox', { name: 'Open search dialog (CMD+K or Ctrl+K)' }));
    const input = await screen.findByRole('combobox');
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(screen.getByRole('button', { name: /Search tools/ }));
    await user.tab();
    expect(screen.getByRole('button', { name: /Search in a section/ })).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: /Exact phrase/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('budget');
    expect(input).toHaveValue('"budget"');
  });
});
