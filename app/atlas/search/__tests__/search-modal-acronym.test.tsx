/**
 * SEARCH-82: exactly two capital letters look the input up in the abbreviation
 * table and search for the recorded phrase — the one case-sensitive input in
 * the app. Lowercase two-letter input keeps the too-short notice, and unknown
 * capitals do too.
 *
 * SEARCH-83: an acronym with several recorded meanings searches nothing — the
 * meanings render as choices, the reader picks one, and the engine's silent
 * in-query expansion never sees multi-meaning entries.
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchModal from '../search-modal';
import { useAtlasSearch } from '../use-atlas-search';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

vi.mock('../abbreviation-artifact', () => ({
  tryLoadAbbreviations: vi.fn(
    async () =>
      new Map([
        ['ad', { acronym: 'ad', phrases: ['aligned delegate'], source: 'curated' }],
        ['sr', { acronym: 'sr', phrases: ['staking rewards', 'savings rate'], source: 'curated' }],
      ]),
  ),
}));

const trees = [
  createDoc('Scope', 'A.1', 'Delegates', 'The delegates scope.', {
    articles: [
      createDoc('Article', 'A.1.1', 'Aligned Delegate Duties', 'What an aligned delegate must do.'),
      createDoc('Article', 'A.1.2', 'Budget Rules', 'The budget rules body.'),
      createDoc('Article', 'A.1.3', 'Staking Rewards', 'How staking rewards accrue.'),
    ],
  }),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

async function openAndType(text: string) {
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, text);
  return user;
}

describe('SearchModal two-capital-letter acronyms (SEARCH-82)', () => {
  it('typing "AD" searches the recorded phrase and says so', async () => {
    await openAndType('AD');
    const note = await screen.findByTestId('acronym-expansion-note', {}, { timeout: 3000 });
    expect(note.textContent).toContain('“AD” is short for “aligned delegate”');
    const options = await screen.findAllByRole('option');
    expect(options.some((option) => option.textContent?.includes('Aligned Delegate Duties'))).toBe(true);
    expect(screen.queryByText(/Keep typing/)).not.toBeInTheDocument();
  });

  it('lowercase "ad" stays too short', async () => {
    await openAndType('ad');
    await screen.findByText(/Keep typing/);
    expect(screen.queryByTestId('acronym-expansion-note')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('two capitals the table does not know stay too short', async () => {
    await openAndType('ZZ');
    await waitFor(() => expect(screen.getByText(/Keep typing/)).toBeInTheDocument());
    expect(screen.queryByTestId('acronym-expansion-note')).not.toBeInTheDocument();
  });
});

describe('SearchModal multi-meaning acronyms (SEARCH-83)', () => {
  it('typing "SR" offers the meanings as choices and searches nothing until one is picked', async () => {
    const user = await openAndType('SR');
    const choices = await screen.findByTestId('acronym-choice', {}, { timeout: 3000 });
    const chips = await screen.findAllByTestId('acronym-choice-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['staking rewards', 'savings rate']);
    expect(screen.getByText(/is short for more than one thing/)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0); // nothing guessed
    expect(screen.queryByText(/Keep typing/)).not.toBeInTheDocument();
    expect(choices).toBeInTheDocument();

    await user.click(chips[0]);
    const options = await screen.findAllByRole('option');
    expect(options.some((option) => option.textContent?.includes('Staking Rewards'))).toBe(true);
    expect(screen.queryByTestId('acronym-choice')).not.toBeInTheDocument();
  });

  it('the engine sees single-meaning entries only — a multi-meaning acronym is invisible to it', async () => {
    const { result } = renderHook(() => useAtlasSearch(trees));
    await waitFor(() => expect(result.current.abbreviationMeaningsOf('sr')).not.toBeNull());
    expect(result.current.abbreviationMeaningsOf('sr')?.phrases).toEqual(['staking rewards', 'savings rate']);
    expect(result.current.abbreviationOf('sr')).toBeNull();
    expect(result.current.abbreviationOf('ad')).toEqual({
      acronym: 'ad',
      phrase: 'aligned delegate',
      source: 'curated',
    });
  });
});
