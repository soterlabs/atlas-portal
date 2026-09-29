/**
 * SEARCH-71: the "Related results" section — the SEARCH-65 direct answers
 * retired their banner and now lead this category; rows carry their stated
 * reason, and connections below the strength floor sit behind the "weaker
 * connections" reveal.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenAtlasDocuments } from '../flatten-documents';
import { type GraphRawFiles, buildGraphArtifact, toGraph } from '../graph-artifact';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

vi.mock('../query-embedder', () => ({
  LocalQueryEmbedder: class {
    async embed(): Promise<Float32Array> {
      return Float32Array.from([1, 0]);
    }
  },
}));

vi.mock('../vector-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector-store')>();
  const { QUERY_EMBEDDING_MODEL } = await import('../embedding-model');
  return {
    ...actual,
    tryLoadVectorStore: async () => {
      const off = Float32Array.from([0, 1]);
      const docNos = ['D.1', 'D.1.1', 'D.1.2'];
      const vectors = docNos.map((docNo) => (docNo === 'D.1.1' ? Float32Array.from([1, 0]) : off));
      const { manifest, blob } = actual.VectorStore.encode(vectors, {
        corpusHash: 'mocked',
        model: QUERY_EMBEDDING_MODEL.key,
        docNos,
      });
      return actual.VectorStore.decode(manifest, blob);
    },
  };
});

const loadGraphMock = vi.hoisted(() => vi.fn());
vi.mock('../graph-artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph-artifact')>();
  return { ...actual, tryLoadGraph: loadGraphMock };
});

// "wrr" appears nowhere in the text, so any wrr query has a thin strict pass.
const trees = [
  createDoc('Scope', 'D.1', 'Requirements', 'The requirements scope.', {
    articles: [
      createDoc('Article', 'D.1.1', 'Weekly Responsibility', 'The weekly duties body.'),
      createDoc('Article', 'D.1.2', 'Other Rules', 'Unrelated body text.'),
    ],
  }),
];

const rawGraph: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [{ id: 'D.1' }, { id: 'D.1.1' }, { id: 'D.1.2' }],
  entities: [{ id: 'wrr', name: 'WRR', aliases: [], tier: 'concept', stands_for: null, mention_count: 5 }],
  mentions: [{ entity: 'wrr', section_id: 'D.1.1', count: 2 }],
  edges: [
    {
      s: 'wrr',
      r: 'responsibility',
      o: 'D.1.1',
      kind: 'entity-section',
      canonical: 'has_duty',
      basis: 'structural',
      section_ids: ['D.1.1'],
    },
  ],
  relations: [{ name: 'has_duty', members: ['responsibility', 'obligation'], oppositional: false }],
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
  render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
  const user = userEvent.setup();
  const input = (await screen.findByPlaceholderText('Search Atlas documents...')) as HTMLInputElement;
  await user.type(input, query);
  await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
  return { user, input };
}

describe('SearchModal Related results (SEARCH-71)', () => {
  it('a full-chain query fills the Related section with reasoned rows; the banner is gone', async () => {
    await openAndType('wrr duties');
    const header = await screen.findByTestId('section-header-related', {}, { timeout: 3000 });
    expect(header.textContent).toContain('Related results (1)');
    // SEARCH-74: Related closes the list — every other section precedes it.
    const headers = screen.getAllByTestId(/section-header-/).map((entry) => entry.getAttribute('data-testid'));
    expect(headers.indexOf('section-header-related')).toBe(headers.length - 1);
    const reasons = await screen.findAllByTestId('related-reason');
    expect(reasons.map((entry) => entry.textContent)).toContain(
      'The related terms “WRR” and “responsibility” are connected in this section.',
    );
    expect(screen.queryByTestId('graph-answers')).not.toBeInTheDocument();
  });

  it('half-matched connections are dropped, not revealed (SEARCH-74)', async () => {
    await openAndType('wrr weather');
    await screen.findAllByRole('option');
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Every connection for this query sits below the strength floor — the
    // category simply does not appear, and no reveal offers the noise.
    expect(screen.queryByTestId('section-header-related')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-quality-toggle-related')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('related-reason')).toHaveLength(0);
  });
});
