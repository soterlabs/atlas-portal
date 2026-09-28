/**
 * SEARCH-84: template-or-silence question answering in the modal. The answer
 * row is additive — the question still runs as a normal search below it — and
 * anything unmatched or unresolved renders exactly today's page.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const loadGraphMock = vi.hoisted(() => vi.fn());
vi.mock('../graph-artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph-artifact')>();
  return { ...actual, tryLoadGraph: loadGraphMock };
});

const trees = [
  createDoc('Scope', 'B.1', 'Allocation', 'Allocation scope text.', {
    articles: [
      createDoc('Article', 'B.1.1', 'Core Facilitator', 'The Core Facilitator stewards governance. More body.'),
      createDoc('Article', 'B.1.2', 'Morpho Vaults', 'The registry of vaults.', {
        articles: [
          createDoc('Article', 'B.1.2.1', 'Grove Vault', 'A vault document.'),
          createDoc('Article', 'B.1.2.2', 'Bloom Vault', 'Another vault document.'),
        ],
      }),
    ],
  }),
];

const rawGraph: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'B.1' }, { id: 'B.1.1' }, { id: 'B.1.2' }, { id: 'B.1.2.1' }, { id: 'B.1.2.2' }],
  entities: [
    { id: 'cf', name: 'Core Facilitator', aliases: ['CF'], tier: 'concept', stands_for: null, mention_count: 9 },
  ],
  mentions: [{ entity: 'cf', section_id: 'B.1.1', count: 3 }],
  edges: [
    {
      s: 'cf',
      r: 'defines',
      o: 'B.1.1',
      kind: 'entity-section',
      canonical: 'defines',
      basis: 'structural',
      section_ids: ['B.1.1'],
    },
  ],
  relations: [{ name: 'defines', members: ['defines'], oppositional: false }],
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
  loadGraphMock.mockReset();
  loadGraphMock.mockImplementation(async () =>
    toGraph(buildGraphArtifact(rawGraph, flattenAtlasDocuments(trees), 'hash').artifact),
  );
});

async function openAndType(query: string) {
  const onClose = vi.fn();
  render(<SearchModal scopeTrees={trees} isOpen onClose={onClose} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, query);
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  return { user, onClose };
}

describe('SearchModal question answering (SEARCH-84)', () => {
  it('answers a definition question and still shows normal results below', async () => {
    await openAndType('Who is the Core Facilitator?');
    const answer = await screen.findByTestId('question-answer', {}, { timeout: 3000 });
    expect(answer.textContent).toContain('Core Facilitator is defined in “Core Facilitator”.');
    expect(answer.textContent).toContain('The Core Facilitator stewards governance.');
    // The keyword leg runs unchanged on the raw question.
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
  });

  it('answers a counting question from the live tree, naming what it counted', async () => {
    await openAndType('How many morpho vaults does sky allocate to?');
    const answer = await screen.findByTestId('question-answer', {}, { timeout: 3000 });
    expect(answer.textContent).toContain('2 documents filed directly under “Morpho Vaults” (B.1.2).');
  });

  it('clicking the answer navigates to its section and closes', async () => {
    const { user, onClose } = await openAndType('How many morpho vaults does sky allocate to?');
    await user.click(await screen.findByTestId('question-answer'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('non-template questions and failed resolutions render no answer row', async () => {
    await openAndType('why is the vault empty');
    await screen.findAllByRole('option');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('question-answer')).not.toBeInTheDocument();

    // Template matches but nothing resolves: 'what is the exceedance rule'.
    // (No entity, no directory — silence, page indistinguishable from search.)
  });

  it('a template with an unresolved subject stays silent', async () => {
    await openAndType('how many unknown widgets are there');
    await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('question-answer')).not.toBeInTheDocument();
  });
});
