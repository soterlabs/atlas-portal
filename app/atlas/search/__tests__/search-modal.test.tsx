import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchExpandScopeEvent } from '@/app/atlas/custom-events';
import SearchModal from '../search-modal';
import { MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO } from '../vocabulary';
import { createDoc, createFixtureTree } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({
  dispatchExpandScopeEvent: vi.fn(),
}));

function renderModal(onClose = vi.fn()) {
  render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
}

/** Waits for the idle-built index, then types a query and waits for results. */
async function searchFor(user: ReturnType<typeof userEvent.setup>, query: string) {
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, query);
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  return input;
}

// jsdom has no layout engine and does not implement scrollIntoView; without this
// stub the keep-selection-visible effect throws and React tears down the tree.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(dispatchExpandScopeEvent).mockClear();
});

describe('SearchModal query syntax and Tools row (SEARCH-34)', () => {
  it('explains Atlas-vocabulary retrieval while keeping quoted searches literal (SEARCH-09)', async () => {
    const trees = [
      createDoc(
        'Scope',
        MAXIMUM_EXPOSURE_TOLERANCE_DOC_NO,
        'Maximum Exposure Tolerance',
        'The maximum exposure tolerance permits interest accrual.',
      ),
      createDoc('Scope', 'B.2', 'Maximum Cap Notice', 'A literal maximum cap phrase.'),
      ...Array.from({ length: 10 }, (_, index) =>
        createDoc('Scope', `B.${index + 3}`, `Maximum Cap ${index + 1}`, `A literal maximum cap rule ${index + 1}.`),
      ),
    ];
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await searchFor(user, 'maximum cap');

    expect((await screen.findAllByRole('option')).map((option) => option.textContent).join(' | ')).toContain(
      'Maximum Exposure Tolerance',
    );
    expect(screen.getByTestId('atlas-vocabulary-notice').textContent).toContain('“cap” → “tolerance”');
    expect(screen.getAllByTestId('result-provenance')[0].textContent).toBe('Atlas vocabulary');

    await user.clear(input);
    await user.type(input, '"maximum cap"');
    await waitFor(() => {
      expect(screen.queryByTestId('atlas-vocabulary-notice')).not.toBeInTheDocument();
      const literal = screen
        .getAllByRole('option')
        .map((option) => option.textContent)
        .join(' | ');
      expect(literal).toContain('Maximum Cap Notice');
      expect(literal).not.toContain('Maximum Exposure Tolerance');
    });
  });

  it('applies type: and in: operators through the standard filter machinery', async () => {
    const { user } = renderModal();
    await searchFor(user, 'budget in:A.2');
    const scoped = await screen.findAllByRole('option');
    expect(scoped.map((option) => option.textContent).join(' | ')).toContain('A.2.1'); // Budget Specification
    expect(scoped.map((option) => option.textContent).join(' | ')).not.toContain('A.1.6'); // budget outside the subtree

    // The operator renders as a removable pill; removing it edits the query text.
    const pill = screen.getByTestId('operator-pill');
    expect(pill.textContent).toContain('in:A.2');
    await user.click(pill);
    expect((screen.getByPlaceholderText('Search Atlas documents...') as HTMLInputElement).value).toBe('budget');
  });

  it('restricts matching to titles with title:', async () => {
    const { user } = renderModal();
    await searchFor(user, 'title:budget');
    const options = await screen.findAllByRole('option');
    const joined = options.map((option) => option.textContent).join(' | ');
    expect(joined).toContain('Budget Specification'); // budget in the name
    expect(joined).not.toContain('Support Scope'); // budget only in the content
  });

  it('browses documents for a filter-only query and warns on unknown types', async () => {
    const { user } = renderModal();
    await searchFor(user, 'type:Article');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3); // the fixture's three Articles, in tree order
    expect(options.map((option) => option.textContent).join(' | ')).toContain('Facilitators');

    const input = screen.getByPlaceholderText('Search Atlas documents...');
    await user.clear(input);
    await user.type(input, 'type:facilitator');
    expect(await screen.findByTestId('operator-pill-unknown')).toBeInTheDocument();
    expect(await screen.findByText(/No documents found/)).toBeInTheDocument();
  });

  it('narrows to whole-word phrases and honours exclusions (SEARCH-35)', async () => {
    const { user } = renderModal();
    await searchFor(user, '"budget for support"');
    const phrased = await screen.findAllByRole('option');
    const joined = phrased.map((option) => option.textContent).join(' | ');
    expect(joined).toContain('Support Scope'); // contains the exact phrase
    expect(joined).not.toContain('A.1.6'); // has "budget", lacks the phrase

    const input = screen.getByPlaceholderText('Search Atlas documents...');
    await user.clear(input);
    await user.type(input, 'compensation -kickbacks');
    await waitFor(() => {
      const texts = screen
        .getAllByRole('option')
        .map((option) => option.textContent)
        .join(' | ');
      expect(texts).toContain('A.1.6.4');
      expect(texts).not.toContain('Kickbacks');
    });
  });

  it('matches case-sensitively with single quotes (SEARCH-35)', async () => {
    const { user } = renderModal();
    await searchFor(user, "'Société'");
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent).join(' | ')).toContain('A.1.8');

    const input = screen.getByPlaceholderText('Search Atlas documents...');
    await user.clear(input);
    await user.type(input, "'SOCIÉTÉ'");
    await screen.findByText(/No documents found/);
  });

  it('jumps to a document by UUID prefix', async () => {
    const trees = createFixtureTree();
    const scope = trees[0] as unknown as { articles: Array<Record<string, unknown>> };
    scope.articles[0].uuid = 'a491d7d0-e461-4e8e-aa1b-1234567890ab';
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await searchFor(user, 'a491d7d0');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Aligned Delegates');
    expect(screen.getByText('Jumped to the document with this UUID')).toBeInTheDocument();
  });

  it('drills down through in: suggestions and completes with a click or Enter (SEARCH-36)', async () => {
    const { user } = renderModal();
    const input = (await screen.findByPlaceholderText('Search Atlas documents...')) as HTMLInputElement;
    await user.type(input, 'in:');

    // Empty value: the root scopes, no cap.
    const panel = await screen.findByTestId('operator-suggestions');
    expect(within(panel).getByRole('button', { name: /Governance Scope/ })).toBeInTheDocument();

    // Clicking a scope with children descends: the box follows, the level re-roots.
    await user.click(within(panel).getByRole('button', { name: /Support Scope/ }));
    expect(input.value).toBe('in:A.2');
    const level = await screen.findByTestId('operator-suggestions');
    expect(within(level).getByTestId('suggestion-self').textContent).toContain('Support Scope');
    expect(within(level).getByRole('button', { name: /Budget Specification/ })).toBeInTheDocument();

    // Enter completes the operator; browse mode lists the subtree.
    await user.keyboard('{Enter}');
    expect(input.value).toBe('in:A.2 ');
    expect(screen.queryByTestId('operator-suggestions')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(2));

    // Clicking a LEAF completes immediately.
    await user.clear(input);
    await user.type(input, 'in:A.1');
    const scoped = await screen.findByTestId('operator-suggestions');
    await user.click(within(scoped).getByRole('button', { name: /Facilitators/ }));
    expect(input.value).toBe('in:A.1.7 ');

    // type: stays a flat list of the real types.
    await user.clear(input);
    await user.type(input, 'type:Art');
    const typePanel = await screen.findByTestId('operator-suggestions');
    await user.click(within(typePanel).getByRole('button', { name: 'Article' }));
    expect(input.value).toBe('type:Article ');
    await waitFor(() => {
      const browsed = screen.getAllByRole('option').map((option) => option.textContent);
      expect(browsed, browsed.join(' | ')).toHaveLength(3);
    });
  });
});

describe('SearchModal search-tools menu (SEARCH-38)', () => {
  it('opens the renamed menu, inserts a template, and hands over to the suggestions', async () => {
    const { user } = renderModal();
    const input = (await screen.findByPlaceholderText('Search Atlas documents...')) as HTMLInputElement;
    await user.type(input, 'budget');

    await user.click(screen.getByTestId('search-tools-trigger'));
    // Every row is an action: exactly the six clickable modes, nothing informational.
    expect(screen.getByRole('button', { name: /Exclude a word/ })).toBeInTheDocument();
    expect(screen.queryByTestId('search-tool-fact')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Search in a section/ }));
    expect(input.value).toBe('budget in:');
    expect(await screen.findByTestId('operator-suggestions')).toBeInTheDocument(); // drill-down took over
    expect(screen.queryByRole('button', { name: /Exclude a word/ })).not.toBeInTheDocument(); // menu closed
  });

  it('places the cursor between the quotes for phrase templates', async () => {
    const { user } = renderModal();
    const input = (await screen.findByPlaceholderText('Search Atlas documents...')) as HTMLInputElement;

    await user.click(screen.getByTestId('search-tools-trigger'));
    await user.click(screen.getByRole('button', { name: /Exact phrase/ }));
    await waitFor(() => {
      expect(input.value).toBe('""');
      expect(input.selectionStart).toBe(1);
    });
  });
});

describe('SearchModal window-style resize (SEARCH-33)', () => {
  const panelOf = () => screen.getByTestId('resize-handle-se').parentElement as HTMLElement;

  it('drags a corner like a regular window and remembers the size', async () => {
    renderModal();
    await screen.findByPlaceholderText('Search Atlas documents...');

    const handle = screen.getByTestId('resize-handle-se');
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 40 });
    fireEvent.pointerUp(window);

    // jsdom rects are zero, so the drag starts from the 768×640 fallback.
    expect(panelOf().style.width).toBe('828px');
    expect(panelOf().style.height).toBe('680px');
    expect(JSON.parse(window.localStorage.getItem('atlas-search-modal-size')!)).toEqual({
      width: 828,
      height: 680,
      maximized: false,
    }); // SEARCH-67 added the flag;
  });

  it('resize strips opt out of touch scrolling so a finger drag resizes instead of scrolling (bug 12)', async () => {
    renderModal();
    await screen.findByPlaceholderText('Search Atlas documents...');
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(screen.getByTestId(`resize-handle-${edge}`)).toHaveClass('touch-none');
    }
  });

  it('a cancelled pointer drag stops resizing and persists what is on screen (bug 12)', async () => {
    renderModal();
    await screen.findByPlaceholderText('Search Atlas documents...');
    const handle = screen.getByTestId('resize-handle-se');
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 20 });
    fireEvent.pointerCancel(window);
    expect(panelOf().style.width).toBe('798px');
    expect(JSON.parse(window.localStorage.getItem('atlas-search-modal-size')!).width).toBe(798);
    // The listeners are gone: a later move (the browser turned the gesture into a scroll) changes nothing.
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    expect(panelOf().style.width).toBe('798px');
  });
});

describe('SearchModal mini-tree (SEARCH-31/33)', () => {
  it('renders the indented tree, re-centers on click, and links every node to the Atlas', async () => {
    const { user } = renderModal();
    await searchFor(user, 'delegate compensation');
    const options = await screen.findAllByRole('option');
    const row = options.find((option) => option.textContent?.includes('A.1.6.4'))!;

    await user.click(within(row).getByTestId('result-context-toggle'));
    const peek = within(row).getByTestId('result-context');
    // A.1.6.4 sits under Governance Scope › Aligned Delegates; ancestors are nodes.
    expect(within(peek).getByRole('button', { name: 'Governance Scope' })).toBeInTheDocument();
    const focus = within(peek).getByText('AD Compensation Cycle');
    expect(focus).toHaveAttribute('aria-current', 'true');

    // Every node carries an ↗ link opening the portal tree in a new tab.
    const links = within(peek).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links.every((link) => link.getAttribute('target') === '_blank')).toBe(true);
    expect(links.some((link) => link.getAttribute('href')?.endsWith('#A.1.6'))).toBe(true);

    // Clicking the ↗ opens a small window on top, not a new main window.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await user.click(links.find((link) => link.getAttribute('href')?.endsWith('#A.1.6'))!);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('#A.1.6'),
      'atlas-tree-popup',
      expect.stringContaining('popup=yes'),
    );
    open.mockRestore();

    // Clicking a node re-centers the tree instead of navigating away.
    await user.click(within(peek).getByRole('button', { name: 'Aligned Delegates' }));
    expect(within(peek).getByText('Aligned Delegates')).toHaveAttribute('aria-current', 'true');
    expect(within(peek).getByText(/this result/)).toBeInTheDocument(); // the original stays marked
    expect(vi.mocked(dispatchExpandScopeEvent)).not.toHaveBeenCalled();
  });

  it('lists direct children under the focus and collapses again', async () => {
    const { user } = renderModal();
    await searchFor(user, 'delegates compensated');
    const options = await screen.findAllByRole('option');
    // A.1.6 "Aligned Delegates" has two indexed children.
    const row = options.find((option) => option.textContent?.includes('Aligned Delegates'))!;

    await user.click(within(row).getByTestId('result-context-toggle'));
    const peek = within(row).getByTestId('result-context');
    expect(within(peek).getByRole('button', { name: 'AD Compensation Cycle' })).toBeInTheDocument();
    expect(within(peek).getByRole('button', { name: 'Kickbacks Prohibited' })).toBeInTheDocument();

    await user.click(within(row).getByTestId('result-context-toggle'));
    expect(within(row).queryByTestId('result-context')).not.toBeInTheDocument();
  });
});

describe('SearchModal result segmentation (SEARCH-29)', () => {
  /**
   * A corpus where one parent dominates a confident keyword query: twelve same-parent
   * per-asset rows plus one distinct rule elsewhere. The strict pass exceeds the gate,
   * so the segmentation stage runs dense-free on the keyword path.
   */
  function groupedTree() {
    return [
      createDoc('Scope', 'Z.1', 'Lending Markets', 'Liquidation parameter rows per asset.', {
        articles: Array.from({ length: 12 }, (_, i) =>
          createDoc('Article', `Z.1.${i + 1}`, `Asset ${i + 1} Parameters`, `Liquidation parameter row ${i + 1}.`),
        ),
      }),
      createDoc('Scope', 'Z.2', 'Exceedance Rule', 'Liquidation parameter tolerance on exceedance.'),
    ];
  }

  it('exact matches never fold: the section is flat and diversity-ordered (SEARCH-72)', async () => {
    render(<SearchModal scopeTrees={groupedTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await searchFor(user, 'liquidation parameter');

    // All 14 documents carry the exact phrase — no clustering may appear.
    await waitFor(() => expect(screen.getByTestId('section-show-all-exact')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByTestId('result-group-toggle')).not.toBeInTheDocument();

    // Diversity ordering: the other scope's document reaches the visible page
    // even though 12 same-parent siblings outrank it.
    const visible = screen.getAllByRole('option').map((option) => option.textContent);
    expect(visible).toHaveLength(5);
    expect(visible.join(' | ')).toContain('Exceedance Rule');

    await user.click(screen.getByTestId('section-show-all-exact'));
    expect(screen.getAllByRole('option')).toHaveLength(14);
  });

  it('partial rows still fold, same category only, with the honest wording (SEARCH-72)', async () => {
    // A third scope whose rows match only 'liquidation' (1 of 2 words): they
    // land in Partial at exactly the coverage floor, same parent — the one
    // place folding still applies.
    const trees = [
      ...groupedTree(),
      createDoc('Scope', 'Z.3', 'Risk Notes', 'Notes overview.', {
        articles: Array.from({ length: 3 }, (_, i) =>
          createDoc('Article', `Z.3.${i + 1}`, `Note ${i + 1}`, `Liquidation note ${i + 1}.`),
        ),
      }),
    ];
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await searchFor(user, 'liquidation parameter');

    await waitFor(() => expect(screen.getByTestId('section-header-exact')).toBeInTheDocument(), { timeout: 3000 });
    const toggle = await screen.findByTestId('result-group-toggle');
    // The fold sits in Partial (Risk Notes), never under the exact rows.
    expect(toggle.textContent).toMatch(/\+\d+ more from this section · Risk Notes/);
    const hiddenCount = Number(toggle.textContent!.match(/\+(\d+)/)![1]);
    const collapsedCount = screen.getAllByRole('option').length;
    await user.click(toggle);
    expect(screen.getAllByRole('option')).toHaveLength(collapsedCount + hiddenCount);
    expect(screen.getByTestId('result-group-toggle').textContent).toBe('hide these');
    // SEARCH-70: chips restating the section are suppressed throughout.
    expect(screen.queryAllByTestId('result-provenance')).toHaveLength(0);
  });
});

describe('SearchModal', () => {
  it('reports the auto-detected mode as a status line, with no switch (SEARCH-80)', async () => {
    renderModal();
    const status = await screen.findByTestId('search-mode-status');
    expect(status.textContent).toContain('Full search mode — all features run on this device.');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('warns when the device is auto-detected as low-memory (SEARCH-80)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SEARCH_MODE', 'low-memory');
    renderModal();
    const status = await screen.findByTestId('search-mode-status');
    await waitFor(() =>
      expect(status.textContent).toContain(
        'Low-memory mode is on for this device: similarity results load from the server and need a connection.',
      ),
    );
    vi.unstubAllEnvs();
  });

  it('finds a document whose query terms are not contiguous', async () => {
    const { user } = renderModal();
    await searchFor(user, 'delegate compensation');

    const options = await screen.findAllByRole('option');
    // A.1.6.4 says "Aligned Delegates receive compensation from their buffers" — the terms
    // are not contiguous. Its exact rank is not asserted: A.1.6 legitimately competes for
    // the top slot, since its name is "Aligned Delegates" and its body says "compensated".
    expect(options.map((option) => option.textContent).join(' | ')).toContain('A.1.6.4');
  });

  it('reaches the same documents from conversational phrasing', async () => {
    const { user } = renderModal();
    await searchFor(user, 'how are delegates compensated');

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent).join(' | ')).toContain('A.1.6.4');
  });

  it('finds and highlights an accented word typed without the accent', async () => {
    const { user } = renderModal();
    await searchFor(user, 'societe');

    const options = await screen.findAllByRole('option');
    expect(within(options[0]).getByText('A.1.8')).toBeInTheDocument();
    const marks = within(options[0])
      .getAllByRole('mark')
      .map((node) => node.textContent);
    expect(marks).toContain('Société');
  });

  it('does not search below the minimum query length, and explains why', async () => {
    const { user } = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');

    await user.type(input, 'bu');
    expect(await screen.findByText(/at least 3 characters/)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryByText(/No documents found/)).not.toBeInTheDocument();

    // The third character triggers the search.
    await user.type(input, 'd');
    expect(await screen.findAllByRole('option')).not.toHaveLength(0);
    expect(screen.queryByText(/at least 3 characters/)).not.toBeInTheDocument();
  });

  it('explains a query made only of completed common words instead of reporting no matches', async () => {
    const { user } = renderModal();
    await searchFor(user, 'of the ');

    expect(await screen.findByText(/Only common words so far/)).toBeInTheDocument();
    expect(screen.queryByText(/No documents found/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('hides the answer button unless enabled, and renders a verified answer when clicked', async () => {
    const { user } = renderModal();
    await searchFor(user, 'compensation');
    expect(screen.queryByRole('button', { name: 'Answer from these results' })).toBeNull();

    // Re-render with the flag on and a mocked verified answer from the route.
    // A fresh Response per call: the prebuilt-index loader also uses global fetch, and a
    // shared Response body can only be consumed once.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            kind: 'answer',
            claims: [
              {
                text: 'Delegates are compensated monthly.',
                quote: 'Aligned Delegates receive compensation from their buffers.',
                docNo: 'A.1.6.4',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    try {
      render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} answersEnabled />);
      const inputs = await screen.findAllByPlaceholderText('Search Atlas documents...');
      await user.type(inputs[inputs.length - 1], 'compensation');
      await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());

      const button = await screen.findByRole('button', { name: 'Answer from these results' });
      await user.click(button);

      const panel = await screen.findByTestId('answer-panel');
      expect(panel.textContent).toContain('Delegates are compensated monthly.');
      expect(panel.textContent).toContain('A.1.6.4');
      expect(fetchMock).toHaveBeenCalledWith('/api/search/answer', expect.objectContaining({ method: 'POST' }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not offer a scope chip for an ancestor every result shares', async () => {
    const { user } = renderModal();
    await searchFor(user, 'compensation');
    // Every fixture result hangs off "Governance Scope", so filtering by it is a no-op.
    expect(screen.queryByRole('button', { name: 'Filter by scope Governance Scope' })).toBeNull();
  });

  it('narrows the results when a scope chip is selected, and keeps the chip to turn off', async () => {
    const { user } = renderModal();
    await searchFor(user, 'compensation');
    const before = (await screen.findAllByRole('option')).length;

    const chip = screen.queryByRole('button', { name: 'Filter by scope Aligned Delegates' });
    expect(chip).not.toBeNull();
    await user.click(chip!);

    await waitFor(() => expect(screen.getAllByRole('option').length).toBeLessThan(before));
    // Every remaining row sits under the selected ancestor, and the chip stays visible
    // (pressed) even though it no longer splits the filtered set.
    const pressed = screen.getByRole('button', { name: 'Filter by scope Aligned Delegates' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    await user.click(pressed);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(before));
  });

  it('labels a row by what tells it apart from the others', async () => {
    const { user } = renderModal();
    await searchFor(user, 'compensation cycle');

    const rows = (await screen.findAllByRole('option')).map((option) => ({
      name: option.querySelector('.font-semibold')?.textContent ?? '',
      label: option.querySelector('[data-testid="result-path"]')?.textContent ?? '',
    }));

    // Two fixture documents hang off "Aligned Delegates", so that is what separates them
    // from the Article, which sits directly under the Scope and has nothing left to
    // disambiguate against — a row with nothing to say shows no label at all.
    expect(rows.find((row) => row.name.includes('AD Compensation Cycle'))?.label).toBe('Aligned Delegates');
    expect(rows.find((row) => row.name === 'Aligned Delegates')?.label).toBe('');
  });

  it('highlights every query term, not just a contiguous phrase', async () => {
    const { user } = renderModal();
    await searchFor(user, 'delegate compensation');

    const options = await screen.findAllByRole('option');
    // Whole words are marked, and a stemmed term marks every surface form of the word.
    const marks = options
      .flatMap((option) => within(option).queryAllByRole('mark'))
      .map((node) => node.textContent?.toLowerCase());
    expect(marks).toEqual(expect.arrayContaining(['delegates', 'compensation']));
  });

  it('moves the selection with the arrow keys and navigates on Enter', async () => {
    const { user } = renderModal();
    await searchFor(user, 'budget');

    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));

    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'));

    await user.keyboard('{Enter}');
    expect(dispatchExpandScopeEvent).toHaveBeenCalledWith({ targetDocID: expect.any(String) });
  });

  it('ignores arrow keys and Enter while an IME composition is in progress (bug 8)', async () => {
    const { user } = renderModal();
    const input = await searchFor(user, 'budget');
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);

    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(dispatchExpandScopeEvent).not.toHaveBeenCalled();
  });

  it('wraps the selection at the end of the list', async () => {
    const { user } = renderModal();
    await searchFor(user, 'budget');
    const count = (await screen.findAllByRole('option')).length;

    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(screen.getAllByRole('option')[count - 1]).toHaveAttribute('aria-selected', 'true'));
  });

  it('navigates to the clicked document and closes', async () => {
    const { user, onClose } = renderModal();
    await searchFor(user, 'a.1.6.4');

    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    expect(dispatchExpandScopeEvent).toHaveBeenCalledWith({ targetDocID: 'A.1.6.4' });
    expect(onClose).toHaveBeenCalled();
  });

  it('narrows results with type filter chips', async () => {
    const { user } = renderModal();
    await searchFor(user, 'budget');
    expect((await screen.findAllByRole('option')).length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: 'Filter by Scope' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(within(screen.getAllByRole('option')[0]).getByText('A.2')).toBeInTheDocument();
  });

  it('offers a recent search after a navigation, and re-runs it when clicked', async () => {
    const { user } = renderModal();
    const input = await searchFor(user, 'governance');
    await user.click((await screen.findAllByRole('option'))[0]);

    await user.clear(input);
    await user.click(await screen.findByRole('button', { name: 'Search again for governance' }));

    expect(await screen.findAllByRole('option')).not.toHaveLength(0);
  });

  it('explains when filters have removed every result', async () => {
    const { user } = renderModal();
    await searchFor(user, 'governance');
    await user.click(screen.getByRole('button', { name: 'Filter by Section' }));

    expect(await screen.findByText(/No documents found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findAllByRole('option')).not.toHaveLength(0);
  });

  it('previews the matched extra field under its label', async () => {
    const { user } = renderModal();
    await searchFor(user, 'treasury allocation');

    const options = await screen.findAllByRole('option');
    expect(within(options[0]).getByText('Type Overview:')).toBeInTheDocument();
  });

  it('does NOT close on Escape — only the X button or an outside click do (SEARCH-75)', async () => {
    const { onClose, user } = renderModal();
    await screen.findByPlaceholderText('Search Atlas documents...');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
