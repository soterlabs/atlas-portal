/**
 * SEARCH-53: evidence-based match labels — chips report how the words matched
 * (exact / word forms / prefix match / typo-corrected), origin notes explain
 * highlight-free matches, and (since SEARCH-58) the section headers and jump bar
 * carry the per-category counts the old count line reported.
 *
 * The dense mock returns only sub-weak-line vectors, so the rung stays hidden and
 * every visible row is a keyword hit with tiered provenance.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      // B.1/B.2 orthogonal (weak-hidden as rung entries); B.3 is a strong semantic hit,
      // so mixed keyword+semantic pages exercise the evidence-count breakdown.
      const off = Float32Array.from([0, 1]);
      const { manifest, blob } = actual.VectorStore.encode([off, off, Float32Array.from([1, 0])], {
        corpusHash: 'mocked',
        model: QUERY_EMBEDDING_MODEL.key,
        docNos: ['B.1', 'B.2', 'B.3'],
      });
      return actual.VectorStore.decode(manifest, blob);
    },
  };
});

function labelsTree() {
  return [
    createDoc('Scope', 'B.1', 'Ledger Scope', 'The compensation ledger overview lives here.', {
      articles: [
        createDoc('Article', 'B.2', 'AxisLegate Registry', 'The legate roster and duties.'),
        createDoc('Article', 'B.3', 'Cooldown Windows', 'Cooling periods apply after changes.'),
      ],
    }),
  ];
}

async function chipTexts(): Promise<string[]> {
  const chips = await screen.findAllByTestId('result-provenance', {}, { timeout: 3000 });
  return chips.map((chip) => chip.textContent ?? '');
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('SearchModal evidence-based labels (SEARCH-53)', () => {
  it('labels a genuinely exact hit "exact match" and counts it as exact', async () => {
    render(<SearchModal scopeTrees={labelsTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'compensation');

    // SEARCH-70: chips that restate the section are suppressed — the exact row
    // and the similar row carry NO chip; the sections say it.
    await waitFor(() => {
      expect(screen.getByTestId('section-jump-exact').textContent).toBe('Exact matches (1)');
      expect(screen.getByTestId('section-jump-similar').textContent).toBe('Similar results (2)');
    });
    expect(screen.queryAllByTestId('result-provenance')).toHaveLength(0);
  });

  it('labels a typo repair "typo-corrected", not "exact match" (the review case)', async () => {
    render(<SearchModal scopeTrees={labelsTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'compensaton');

    const texts = await chipTexts();
    expect(texts).toContain('typo-corrected');
    expect(texts).not.toContain('exact match');
    // SEARCH-70: the typo repair fails the exact test (the typed word never
    // occurs) — it presents as a Partial match, with its chip explaining why.
    await waitFor(() => {
      expect(screen.queryByTestId('section-jump-exact')).not.toBeInTheDocument();
      expect(screen.getByTestId('section-jump-partial').textContent).toBe('Partial matches (1)');
      expect(screen.getByTestId('section-jump-similar').textContent).toBe('Similar results (2)');
    });
  });

  it('labels a prefix expansion "prefix match" (the axis → AxisLegate case)', async () => {
    render(<SearchModal scopeTrees={labelsTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'axis');

    expect(await chipTexts()).toContain('prefix match');
  });

  it('explains a title-only match with an origin note', async () => {
    render(<SearchModal scopeTrees={labelsTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'axislegate');

    const note = await screen.findByTestId('match-origin-note', {}, { timeout: 3000 });
    expect(note.textContent).toBe('matches in the title');
  });

  it('never labels the semantic tier with keyword evidence', async () => {
    render(<SearchModal scopeTrees={labelsTree()} isOpen onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'compensation');

    // SEARCH-70: the rung row's 'similar' chip is suppressed (its section says
    // it); no keyword-evidence chip may appear on it either.
    await waitFor(() => expect(screen.getByTestId('section-jump-similar')).toBeInTheDocument());
    expect(screen.queryAllByTestId('result-provenance')).toHaveLength(0);
    expect(screen.queryByTestId('match-origin-note')).toBeNull(); // content match carries marks
  });
});
