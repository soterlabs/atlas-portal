/**
 * Bug 9: a document whose only graph connection is BELOW the Related strength floor
 * was still claimed out of Similar/Partial by a section that then refused to show it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));
vi.mock('../segmentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../segmentation')>();
  return { ...actual, segmentCandidates: (candidates: unknown[]) => candidates, summarizeGroups: () => [] };
});

// Twelve exact documents (strict past the confident gate, so sections render without a
// dense mock) plus ONE partial document that matches only "capital".
const trees = [
  createDoc('Scope', 'C.1', 'Capital Rule', 'The capital rule scope.', {
    articles: [
      ...Array.from({ length: 11 }, (_, index) =>
        createDoc('Article', `C.1.${index + 1}`, `Capital Rule ${index + 1}`, `Capital rule detail ${index + 1}.`),
      ),
      createDoc('Article', 'C.1.99', 'Capital Uses', 'Capital uses body.'),
    ],
  }),
];

// "capital" covers 1 of the 2 query stems of "capital rule": strength 0.5, below the 0.66 floor.
const rawGraph: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'C.1' }, ...Array.from({ length: 11 }, (_, i) => ({ id: `C.1.${i + 1}` })), { id: 'C.1.99' }],
  entities: [{ id: 'capital', name: 'Capital', aliases: [], tier: 'concept', stands_for: null, mention_count: 3 }],
  mentions: [{ entity: 'capital', section_id: 'C.1.99', count: 3 }],
  edges: [],
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
  loadGraphMock.mockImplementation(async () =>
    toGraph(buildGraphArtifact(rawGraph, flattenAtlasDocuments(trees), 'hash').artifact),
  );
});

describe('Related strength floor (bug 9)', () => {
  it('a partial match with only a below-floor connection stays in Partial matches', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'capital rule');
    await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
    await waitFor(() => expect(loadGraphMock).toHaveBeenCalled());
    const partial = await screen.findByTestId('section-header-partial', {}, { timeout: 3000 });
    expect(partial.textContent).toContain('Partial matches (1)');
    expect(screen.getAllByRole('option').some((option) => option.textContent?.includes('C.1.99'))).toBe(true);
    expect(screen.queryByTestId('section-header-related')).not.toBeInTheDocument();
  });
});
