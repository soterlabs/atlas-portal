/**
 * Bug 2: an operator filter plus a residual below the minimum query length is BROWSE
 * mode (tree order, no ranking). The dense upgrade must not run for it, or its async
 * result replaces the browse listing with a ranked list.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const hybridMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../hybrid-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hybrid-search')>();
  return { ...actual, searchAtlasHybrid: hybridMock };
});

const trees = [
  createDoc('Scope', 'B.1', 'Requirements', 'Requirement text.', {
    articles: [
      createDoc('Article', 'B.1.1', 'Alpha Rule', 'The alpha rule body.'),
      createDoc('Article', 'B.1.2', 'Beta Rule', 'The beta rule body.'),
    ],
    annotations: [createDoc('Annotation', 'B.1.3', 'Note', 'An annotation.')],
  }),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  window.localStorage.clear();
  hybridMock.mockClear();
});

describe('browse mode and the dense upgrade (bug 2)', () => {
  it('never calls the hybrid engine for a filter-only query with a short residual', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'type:Article ab');
    await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('B.1.1'),
      expect.stringContaining('B.1.2'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hybridMock).not.toHaveBeenCalled();
  });

  it('still upgrades a real query', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'alpha rule');
    await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
    await screen.findAllByRole('option');
    await waitFor(() => expect(hybridMock).toHaveBeenCalled());
  });
});
