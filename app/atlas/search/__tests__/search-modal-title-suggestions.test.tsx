import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

// SEARCH-57: `title:` keyword suggestions. checklist in 3 titles, spark in 3,
// vault in 2, the rest in one each.
const trees = [
  createDoc('Scope', 'A.1', 'Checklist Hub', 'Hub text.', {
    articles: [
      createDoc('Article', 'A.1.1', 'Spark Checklist', 'Spark checklist text.'),
      createDoc('Article', 'A.1.2', 'Vault Checklist', 'Vault checklist text.'),
      createDoc('Article', 'A.1.3', 'Spark Vault Rules', 'Rules text.'),
    ],
  }),
  createDoc('Scope', 'A.2', 'Spark Overview', 'Overview text.'),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

async function openWith(query: string) {
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = (await screen.findByPlaceholderText('Search Atlas documents...')) as HTMLInputElement;
  await user.type(input, query);
  return { user, input };
}

describe('SearchModal title: suggestions (SEARCH-57)', () => {
  it('lists title keywords frequency-sorted with counts, filters on a partial, completes on click', async () => {
    const { user, input } = await openWith('title:');

    const panel = await screen.findByTestId('operator-suggestions');
    const labels = within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toEqual(['checklist (3)', 'spark (3)', 'vault (2)', 'hub (1)', 'overview (1)', 'rules (1)']);

    await user.type(input, 'ch');
    const filtered = await screen.findByTestId('operator-suggestions');
    expect(within(filtered).getAllByRole('button')).toHaveLength(1);

    await user.click(within(filtered).getByRole('button', { name: /checklist/ }));
    expect(input.value).toBe('title:checklist ');
  });

  it('a second title: shows co-occurrence counts over the terms already in the query', async () => {
    const { input } = await openWith('title:checklist title:');

    const panel = await screen.findByTestId('operator-suggestions');
    const labels = within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent);
    // Only keywords sharing a title with "checklist"; checklist itself is excluded.
    expect(labels).toEqual(['hub (1)', 'spark (1)', 'vault (1)']);
    expect(input.value).toBe('title:checklist title:');
  });

  it('a partial no keyword starts with hides the panel; in: suggestions are untouched', async () => {
    const { user, input } = await openWith('title:zzz');
    expect(screen.queryByTestId('operator-suggestions')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'in:');
    const panel = await screen.findByTestId('operator-suggestions');
    expect(within(panel).getByRole('button', { name: /Checklist Hub/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Checklist Hub/ }).textContent).not.toContain('(');
  });
});
