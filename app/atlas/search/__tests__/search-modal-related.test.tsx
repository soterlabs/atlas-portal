/**
 * SEARCH-63: the per-result "related documents" disclosure — lazy graph load on the
 * first expand, reason lines, click-through navigation, and the quiet degradation
 * when the artifact is absent or stale.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const trees = [
  createDoc('Scope', 'B.1', 'Requirements', 'Requirement text.', {
    articles: [
      createDoc('Article', 'B.1.1', 'Capital Rule', 'The capital rule body.'),
      createDoc('Article', 'B.1.2', 'Capital Uses', 'Capital uses body.'),
      createDoc('Article', 'B.1.3', 'Citing Article', 'Cites the capital rule.'),
    ],
  }),
];

const rawGraph: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'B.1' }, { id: 'B.1.1' }, { id: 'B.1.2' }, { id: 'B.1.3' }],
  entities: [
    { id: 'capital', name: 'Capital', aliases: [], tier: 'concept', stands_for: null, mention_count: 4 },
    { id: 'debt', name: 'Debt', aliases: [], tier: 'concept', stands_for: null, mention_count: 2 },
  ],
  mentions: [
    { entity: 'capital', section_id: 'B.1.1', count: 3 },
    { entity: 'capital', section_id: 'B.1.2', count: 2 },
    { entity: 'debt', section_id: 'B.1.2', count: 1 },
  ],
  edges: [
    { s: 'B.1.3', r: 'references', o: 'B.1.1', kind: 'section-section' },
    {
      s: 'capital',
      r: 'opposite_of',
      o: 'debt',
      kind: 'entity-entity',
      opposition_kind: 'antonym',
      section_ids: ['B.1.2'],
    },
  ],
};

const loadGraphMock = vi.hoisted(() => vi.fn());
vi.mock('../graph-artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph-artifact')>();
  return { ...actual, tryLoadGraph: loadGraphMock };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
  loadGraphMock.mockReset();
});

async function openAndSearch() {
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Search Atlas documents...');
  await user.type(input, 'capital rule');
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  await screen.findAllByRole('option');
  return user;
}

describe('SearchModal related documents (SEARCH-63)', () => {
  it('loads the graph lazily on first expand and lists related documents with reasons', async () => {
    loadGraphMock.mockImplementation(async () => {
      const documents = flattenAtlasDocuments(trees);
      return toGraph(buildGraphArtifact(rawGraph, documents, 'hash').artifact);
    });
    const user = await openAndSearch();
    expect(loadGraphMock).not.toHaveBeenCalled(); // never on modal open

    const toggles = screen.getAllByTestId('result-related-toggle');
    await user.click(toggles[0]);
    expect(loadGraphMock).toHaveBeenCalledTimes(1);

    const panel = await screen.findByTestId('related-documents');
    await waitFor(() => {
      const text = within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(text.some((line) => line?.includes('Citing Article') && line.includes('cites this document'))).toBe(true);
      // SEARCH-64: the opposite pair renders with the relationship stated.
      expect(
        text.some((line) => line?.includes('Capital Uses') && line.includes('about Debt, the opposite of Capital')),
      ).toBe(true);
    });

    // A second expand elsewhere never reloads the artifact.
    await user.click(toggles[0]);
    await user.click(toggles[0]);
    expect(loadGraphMock).toHaveBeenCalledTimes(1);
  });

  it('degrades to a quiet note when the artifact is absent or stale', async () => {
    loadGraphMock.mockResolvedValue(null);
    const user = await openAndSearch();
    await user.click(screen.getAllByTestId('result-related-toggle')[0]);
    const panel = await screen.findByTestId('related-documents');
    await waitFor(() =>
      expect(panel.textContent).toContain('Related information isn’t available for this Atlas version.'),
    );
  });

  it('says so when the graph records nothing for the document', async () => {
    loadGraphMock.mockImplementation(async () => {
      const documents = flattenAtlasDocuments(trees);
      return toGraph(buildGraphArtifact({ ...rawGraph, mentions: [], edges: [] }, documents, 'hash').artifact);
    });
    const user = await openAndSearch();
    await user.click(screen.getAllByTestId('result-related-toggle')[0]);
    const panel = await screen.findByTestId('related-documents');
    await waitFor(() => expect(panel.textContent).toContain('No related documents recorded.'));
  });
});
