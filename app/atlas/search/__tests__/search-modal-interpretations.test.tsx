/**
 * SEARCH-62: graph interpretation chips — trigger coupling to the thin-strict
 * signal, lazy graph load, honest counts, and click-through rewrites.
 *
 * The dense side is mocked (the SEARCH-52 test pattern): the rung fires for the
 * acronym query, which is the trigger; the graph is mocked at the loader seam.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
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
      // Flatten order: C.1, C.1.1 (spelled-out doc), C.1.2, then the 10 fillers.
      // The spelled-out doc embeds at [1,0] so the mocked query retrieves it.
      const off = Float32Array.from([0, 1]);
      const docNos = ['C.1', 'C.1.1', 'C.1.2', ...Array.from({ length: 10 }, (_, i) => `C.1.${i + 3}`)];
      const vectors = docNos.map((docNo) => (docNo === 'C.1.1' ? Float32Array.from([1, 0]) : off));
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

// "wrr" appears nowhere in the text (thin strict); the spelled-out phrase does.
const trees = [
  createDoc('Scope', 'C.1', 'Requirements', 'The requirements scope.', {
    articles: [
      createDoc('Article', 'C.1.1', 'Weekly Ratio Requirement', 'The weekly ratio requirement is 2%.'),
      createDoc('Article', 'C.1.2', 'Other Rules', 'Unrelated body text.'),
      // 10 fillers so 'unrelated body text' has a CONFIDENT strict pass (≥ 10).
      ...Array.from({ length: 10 }, (_, index) =>
        createDoc('Article', `C.1.${index + 3}`, `Filler ${index + 1}`, `Unrelated body text ${index + 1}.`),
      ),
    ],
  }),
];

const rawGraph: GraphRawFiles = {
  meta: { atlas_version: 'test', schema_version: 2 },
  sections: [
    { id: 'C.1' },
    { id: 'C.1.1' },
    { id: 'C.1.2' },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `C.1.${index + 3}` })),
  ],
  entities: [
    {
      id: 'wrr',
      name: 'WRR',
      aliases: ['Weekly Ratio Requirement'],
      tier: 'concept',
      stands_for: 'Weekly Ratio Requirement',
      mention_count: 5,
    },
    { id: 'other_rules', name: 'Other Rules', aliases: [], tier: 'concept', stands_for: null, mention_count: 2 },
  ],
  mentions: [
    { entity: 'wrr', section_id: 'C.1.1', count: 2 },
    { entity: 'other_rules', section_id: 'C.1.2', count: 1 },
  ],
  edges: [
    {
      s: 'other_rules',
      r: 'opposite_of',
      o: 'wrr',
      kind: 'entity-entity',
      opposition_kind: 'failure',
      section_ids: [],
    },
  ],
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

describe('SearchModal graph interpretation chips (SEARCH-62)', () => {
  it('fires on a thin-strict acronym query, loads the graph lazily, and rewrites on click', async () => {
    const { user, input } = await openAndType('wrr');

    const notice = await screen.findByTestId('graph-interpretations', {}, { timeout: 3000 });
    expect(loadGraphMock).toHaveBeenCalledTimes(1);
    const chips = within(notice).getAllByTestId('graph-interpretation-chip');
    const texts = chips.map((entry) => entry.textContent);
    // The count is real: one document strictly matches the spelled-out phrase.
    expect(texts).toContain('“Weekly Ratio Requirement” (1)');
    // SEARCH-64: the recorded opposite renders as a labeled chip with its count.
    expect(texts).toContain('“Other Rules” — the failure mode of Weekly Ratio Requirement (1)');

    const chip = chips.find((entry) => entry.textContent === '“Weekly Ratio Requirement” (1)')!;
    await user.click(chip);
    expect(input.value).toBe('Weekly Ratio Requirement');
    // The rewritten query is a confident strict match: the trigger clears and the
    // notice leaves with it.
    await waitFor(() => expect(screen.queryByTestId('graph-interpretations')).not.toBeInTheDocument());
  });

  it('never fires chips on a confident query — the graph now loads for the Related section instead', async () => {
    await openAndType('unrelated body text');
    await screen.findAllByRole('option');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('graph-interpretations')).not.toBeInTheDocument();
    // SEARCH-71 load policy: any plain query loads the graph once per session.
    expect(loadGraphMock).toHaveBeenCalledTimes(1);
    // No entity resolves for this query, so no Related section either.
    expect(screen.queryByTestId('section-header-related')).not.toBeInTheDocument();
  });

  it('stays silent when the graph artifact is unavailable', async () => {
    loadGraphMock.mockResolvedValue(null);
    await openAndType('wrr');
    await screen.findAllByRole('option');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('graph-interpretations')).not.toBeInTheDocument();
  });
});
