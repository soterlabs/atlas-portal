/**
 * Bug 7: the keyboard selection was stored by list position. The async dense upgrade
 * recomposes the list under the same key, so the highlight jumped and an armed Enter
 * opened whatever now sat at that index. Selection must follow the document.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchExpandScopeEvent } from '@/app/atlas/custom-events';
import SearchModal from '../search-modal';
import { createDoc } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

// The embedder waits until the test releases it, so the upgrade lands AFTER ArrowDown.
const gate = vi.hoisted(() => ({ release: () => {}, promise: Promise.resolve() }));
vi.mock('../query-embedder', () => ({
  LocalQueryEmbedder: class {
    async embed(): Promise<Float32Array> {
      await gate.promise;
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
      // Flatten order: B.1 (strict), B.1.1 (relaxed; dense 0.7 → rung), B.1.2 (OOV; dense 1.0 → rung first).
      const vectors = [Float32Array.from([0, 1]), Float32Array.from([0.7, 0.714]), Float32Array.from([1, 0])];
      const { manifest, blob } = actual.VectorStore.encode(vectors, {
        corpusHash: 'mocked',
        model: QUERY_EMBEDDING_MODEL.key,
        docNos: ['B.1', 'B.1.1', 'B.1.2'],
      });
      return actual.VectorStore.decode(manifest, blob);
    },
  };
});

const trees = [
  createDoc('Scope', 'B.1', 'Alpha Beta Rule', 'The alpha beta combination.', {
    articles: [
      createDoc('Article', 'B.1.1', 'Alpha Note', 'Only alpha here.'),
      createDoc('Article', 'B.1.2', 'Gamma Topic', 'Nothing lexical in common.'),
    ],
  }),
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(dispatchExpandScopeEvent).mockClear();
  gate.promise = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
});

describe('selection survives the dense upgrade (bug 7)', () => {
  it('keeps the arrowed document selected when the list recomposes, and Enter opens it', async () => {
    render(<SearchModal scopeTrees={trees} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'alpha beta');
    await waitFor(() => expect(screen.queryByText('Indexing…')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2)); // B.1, B.1.1 (keyword only)

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveTextContent('B.1.1'));
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    gate.release();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3)); // B.1, B.1.2 (rung), B.1.1

    const selected = screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveTextContent('B.1.1');

    await user.keyboard('{Enter}');
    expect(dispatchExpandScopeEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchExpandScopeEvent).mock.calls[0][0]).toEqual({ targetDocID: 'B.1.1' });
  });
});
