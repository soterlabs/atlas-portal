import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryRewriteResponse } from '@/app/shared/search-query-rewrite';
import SearchModal from '../search-modal';
import { createFixtureTree } from './fixtures';

vi.mock('@/app/atlas/custom-events', () => ({ dispatchExpandScopeEvent: vi.fn() }));

const rewriteResponse: QueryRewriteResponse = {
  schemaVersion: 1,
  originalQuery: 'how do delegates get paid',
  normalizedQuery: 'how do delegates get paid',
  searchQuery: 'aligned delegate compensation',
  rewrite: {
    terms: ['aligned delegate', 'compensation'],
    filters: { types: [], scopes: [] },
    boolean: { must: [], should: [] },
  },
  config: { mode: 'terms-and-filters', context: 'glossary-examples', effort: 'low' },
  model: 'claude-opus-5',
  cacheHit: false,
  latencyMs: 200,
  usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0.001 },
};

function renderModal() {
  render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} queryRewriteEnabled />);
  return userEvent.setup();
}

function rewriteCalls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetchMock.mock.calls.filter(([input]) => input === '/api/search/rewrite');
}

function rewriteForRequest(init: RequestInit | undefined, overrides: Partial<typeof rewriteResponse> = {}) {
  const request = JSON.parse(String(init?.body)) as { query: string };
  const originalQuery = request.query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return {
    ...rewriteResponse,
    originalQuery,
    normalizedQuery: originalQuery.toLocaleLowerCase('en-US'),
    ...overrides,
  };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SearchModal query understanding', () => {
  it('does not expose a broken Ask action when the server feature is not configured', async () => {
    render(<SearchModal scopeTrees={createFixtureTree()} isOpen onClose={vi.fn()} />);
    await screen.findByPlaceholderText('Search Atlas documents...');
    expect(screen.queryByRole('button', { name: 'Ask Atlas to rewrite query' })).not.toBeInTheDocument();
  });

  it('never spends a server call while the reader is merely typing', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const user = renderModal();

    await user.type(await screen.findByPlaceholderText('Search Atlas documents...'), 'how do delegates get paid');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(rewriteCalls(fetchMock)).toHaveLength(0);
  });

  it('applies and exposes an explicit Ask rewrite, then restores the reader words in one click', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(rewriteResponse));
    vi.stubGlobal('fetch', fetchMock);
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');

    await user.type(input, 'how do delegates get paid');
    await user.click(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' }));

    expect(await screen.findByText(/Searching for:/)).toHaveTextContent('aligned delegate compensation');
    expect(input).toHaveValue('aligned delegate compensation');
    expect(rewriteCalls(fetchMock)).toHaveLength(1);
    const request = JSON.parse(String(rewriteCalls(fetchMock)[0]?.[1]?.body));
    expect(request).toMatchObject({
      query: 'how do delegates get paid',
      mode: 'terms-and-filters',
      context: 'glossary-examples',
      effort: 'low',
    });
    expect(request.availableScopes).toContain('Governance Scope');

    await user.click(screen.getByRole('button', { name: 'Search my words instead' }));
    expect(input).toHaveValue('how do delegates get paid');
    expect(screen.queryByText(/Searching for:/)).not.toBeInTheDocument();
    expect(rewriteCalls(fetchMock)).toHaveLength(1);
  });

  it('leaves the current keyword search untouched when Ask fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json({ error: 'Query rewriting is not enabled' }, { status: 503 })),
    );
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'delegate compensation');

    await user.click(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('current search is unchanged');
    expect(input).toHaveValue('delegate compensation');
    expect(await screen.findAllByRole('option')).not.toHaveLength(0);
  });

  it('adds allow-listed model filters and removes only those filters on fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        Response.json(
          rewriteForRequest(init, {
            rewrite: { ...rewriteResponse.rewrite, filters: { types: ['Article'], scopes: [] } },
          }),
        ),
      ),
    );
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'delegate compensation');
    await user.click(screen.getByRole('button', { name: 'Filter by Section' }));
    expect(screen.getByRole('button', { name: 'Filter by Section' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' }));
    await screen.findByText(/Searching for:/);
    expect(screen.getByRole('button', { name: 'Filter by Section' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Filter by Article' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Search my words instead' }));
    expect(screen.getByRole('button', { name: 'Filter by Section' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Filter by Article' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('applies only corpus scopes and includes the matching root Scope document itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        Response.json(
          rewriteForRequest(init, {
            searchQuery: 'governance',
            rewrite: {
              terms: ['governance'],
              filters: { types: [], scopes: ['Governance Scope'] },
              boolean: { must: [], should: [] },
            },
          }),
        ),
      ),
    );
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'governance rules');
    await user.click(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Searching for: governance');
    const options = await screen.findAllByRole('option');
    expect(
      options.some((option) => option.textContent?.includes('A.1') && option.textContent.includes('Governance Scope')),
    ).toBe(true);
  });

  it('does not offer Ask for a query the server contract would reject as too long', async () => {
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'x'.repeat(501));
    expect(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' })).toBeDisabled();
  });

  it('ignores a stale rewrite when the reader edits while the request is pending', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => new Promise<Response>((done) => (resolve = done))),
    );
    const user = renderModal();
    const input = await screen.findByPlaceholderText('Search Atlas documents...');
    await user.type(input, 'delegate pay');
    await user.click(screen.getByRole('button', { name: 'Ask Atlas to rewrite query' }));

    await user.type(input, ' today');
    await act(async () => resolve(Response.json(rewriteResponse)));
    await waitFor(() => expect(input).toHaveValue('delegate pay today'));
    expect(screen.queryByText(/Searching for:/)).not.toBeInTheDocument();
  });
});
