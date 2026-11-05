/**
 * Tests for the tarball+compose loader.
 *
 * Covers:
 * - Real tarball download + extract (using a small fixture tarball, not mocked tar).
 * - SHA-keyed cache: same SHA → no re-fetch; different SHA → re-fetch + recompose.
 * - Dev-mode fallback uses the vendored fixture without network access.
 */
// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATLAS_REPO_COMMITS_URL, ATLAS_REPO_TARBALL_URL } from './constants';
import {
  _clearAtlasComposeCache,
  fetchAtlasMarkdownContent,
  fetchAtlasMarkdownMetadata,
  loadAtlasMarkdownForSync,
  loadAtlasMarkdownFromGitHub,
  refreshAtlasSourceNow,
} from './load-atlas-tree-from-github';

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures');
const FIXTURE_TARBALL = path.join(FIXTURE_DIR, 'atlas-content.tar.gz');
const FIXTURE_EXPECTED = path.join(FIXTURE_DIR, 'atlas-content-expected.md');

interface MockResponseSpec {
  url: string;
  status: number;
  body: string | Buffer;
  contentType: string;
}

let fetchMock: ReturnType<typeof vi.fn>;
let fetchCallCount: number;

function setupFetchMocks(specs: MockResponseSpec[]): void {
  fetchCallCount = 0;
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    fetchCallCount++;
    const url = typeof input === 'string' ? input : input.toString();
    const match = specs.find((s) => url === s.url);
    if (!match) {
      throw new Error(`unexpected fetch URL: ${url}`);
    }
    if (typeof match.body === 'string') {
      return new Response(match.body, {
        status: match.status,
        headers: { 'content-type': match.contentType },
      });
    }
    // Body is a Buffer (tarball bytes). Use a ReadableStream.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(match.body as Buffer));
        controller.close();
      },
    });
    return new Response(stream, {
      status: match.status,
      headers: { 'content-type': match.contentType },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function commitResponse(sha: string, message: string, date: string = '2026-05-02T00:00:00Z'): string {
  return JSON.stringify({
    sha,
    commit: {
      message,
      committer: { date },
    },
  });
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  _clearAtlasComposeCache();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('tarball download + extract + compose', () => {
  it('downloads, extracts, and composes a real tarball', async () => {
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    const expected = fs.readFileSync(FIXTURE_EXPECTED, 'utf8');
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('aaaaaaaa', 'initial'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    const content = await fetchAtlasMarkdownContent();
    expect(content).toBe(expected);
  });

  it('returns full {content, lastModified, commitSha, commitMessage} from loadAtlasMarkdownFromGitHub', async () => {
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('bbbbbbbb', 'second commit', '2026-04-01T12:00:00Z'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    const result = await loadAtlasMarkdownFromGitHub();
    expect(result.commitSha).toBe('bbbbbbbb');
    expect(result.commitMessage).toBe('second commit');
    expect(result.lastModified).toEqual(new Date('2026-04-01T12:00:00Z'));
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('throws on a non-2xx commits response', async () => {
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 500,
        body: 'server error',
        contentType: 'text/plain',
      },
    ]);
    await expect(fetchAtlasMarkdownContent()).rejects.toThrow(/Failed to fetch latest commit metadata/);
  });

  it('throws on a non-2xx tarball response', async () => {
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('cccccccc', 'x'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 502,
        body: 'gateway timeout',
        contentType: 'text/plain',
      },
    ]);
    await expect(fetchAtlasMarkdownContent()).rejects.toThrow(/Failed to fetch repo tarball/);
  });
});

describe('compose cache hot path', () => {
  it('serves the cached content on subsequent calls without making synchronous network calls', async () => {
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-stable', 'first'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    // Cold start: 1 commits + 1 tarball = 2 fetches.
    const c1 = await fetchAtlasMarkdownContent();
    const callsAfterFirst = fetchCallCount;
    expect(callsAfterFirst).toBe(2);

    // Hot path: cached content returned synchronously; the background refresh
    // is fire-and-forget and gated by the refresh interval, so within the
    // interval the second call adds no synchronous network calls.
    const c2 = await fetchAtlasMarkdownContent();
    expect(c2).toBe(c1);
    expect(fetchCallCount).toBe(callsAfterFirst); // no new synchronous fetches
  });

  it('preserves the cache when an upstream fetch later fails', async () => {
    // Verifies the contract that user requests do not see 5xx for content we
    // have already successfully composed. A subsequent failure of the upstream
    // tarball does not invalidate the in-memory cache, and the public reader
    // continues to return the previously-composed content.
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-warm', 'first'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    const c1 = await fetchAtlasMarkdownContent();
    expect(c1.length).toBeGreaterThan(0);

    // Replace fetch with a failing impl. The cache is already populated,
    // so subsequent reads should still return the warm content.
    globalThis.fetch = (async () => {
      throw new Error('upstream temporarily unavailable');
    }) as unknown as typeof fetch;

    const c2 = await fetchAtlasMarkdownContent();
    expect(c2).toBe(c1);
  });
});

describe('refreshAtlasSourceNow', () => {
  function specs(sha: string, tarballBytes: Buffer): MockResponseSpec[] {
    return [
      { url: ATLAS_REPO_COMMITS_URL, status: 200, body: commitResponse(sha, sha), contentType: 'application/json' },
      { url: ATLAS_REPO_TARBALL_URL, status: 200, body: tarballBytes, contentType: 'application/gzip' },
    ];
  }

  it('picks up a new commit immediately instead of waiting for the refresh interval', async () => {
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks(specs('sha-old', tarballBytes));
    await loadAtlasMarkdownFromGitHub(); // cold start at sha-old

    // Upstream advances. Within the refresh interval a normal read still serves sha-old.
    setupFetchMocks(specs('sha-new', tarballBytes));
    const before = await loadAtlasMarkdownFromGitHub();
    expect(before.commitSha).toBe('sha-old');

    // A forced refresh re-checks the branch and recomposes: commits + tarball.
    setupFetchMocks(specs('sha-new', tarballBytes));
    const sha = await refreshAtlasSourceNow();
    expect(sha).toBe('sha-new');
    expect(fetchCallCount).toBe(2);
    const after = await loadAtlasMarkdownFromGitHub();
    expect(after.commitSha).toBe('sha-new');
  });

  it('only checks the commit when the SHA is unchanged', async () => {
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks(specs('sha-same', tarballBytes));
    await loadAtlasMarkdownFromGitHub();

    setupFetchMocks(specs('sha-same', tarballBytes));
    const sha = await refreshAtlasSourceNow();
    expect(sha).toBe('sha-same');
    expect(fetchCallCount).toBe(1); // commits lookup only, no tarball
  });
});

describe('cold-start coalescing', () => {
  it('serializes concurrent cold-start callers onto a single fetch', async () => {
    // Regression test for the 2026-05-07 ENOSPC incident: many concurrent
    // cold-start requests on a fresh Lambda each spawned their own tarball
    // download+extract into /tmp, exhausting Vercel's ~512MB /tmp budget.
    // With coalescing, N concurrent first callers share a single in-flight
    // download — total fetch count must be 2 (one /commits + one /tarball).
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-coalesce', 'concurrent'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);

    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () => fetchAtlasMarkdownContent()));

    // All callers see the same composed content.
    const expected = fs.readFileSync(FIXTURE_EXPECTED, 'utf8');
    for (const r of results) {
      expect(r).toBe(expected);
    }
    // Critical: only ONE upstream pair was issued, not N pairs.
    expect(fetchCallCount).toBe(2);
  });

  it('coalesces a mix of fetchAtlasMarkdownContent and loadAtlasMarkdownFromGitHub callers', async () => {
    // Both public read functions must share the same in-flight cold-start —
    // otherwise a concurrent caller through the alternate function would
    // still double-fetch.
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-mixed', 'mixed concurrent'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);

    const [content1, full, content2] = await Promise.all([
      fetchAtlasMarkdownContent(),
      loadAtlasMarkdownFromGitHub(),
      fetchAtlasMarkdownContent(),
    ]);

    expect(content1.length).toBeGreaterThan(0);
    expect(full.content).toBe(content1);
    expect(content2).toBe(content1);
    expect(full.commitSha).toBe('sha-mixed');
    expect(fetchCallCount).toBe(2);
  });

  it('clears the in-flight handle after completion so the next cold start can run', async () => {
    // After the first cold start completes the cache is populated, so
    // subsequent reads use the hot path. But if we manually clear the cache
    // (simulating a fresh Lambda), a brand-new cold start must succeed —
    // ensures the in-flight promise was nulled out in the finally block.
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-restart', 'first'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    await fetchAtlasMarkdownContent();
    expect(fetchCallCount).toBe(2);

    // New "Lambda" — clear cache, swap in fresh mocks, fetch again.
    _clearAtlasComposeCache();
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-restart-2', 'second'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    const content = await fetchAtlasMarkdownContent();
    expect(content.length).toBeGreaterThan(0);
    expect(fetchCallCount).toBe(2);
  });

  it('clears the in-flight handle on failure so the next caller can retry', async () => {
    // If the first cold-start fails, the in-flight promise must be cleared
    // so that the *next* request triggers a fresh attempt. Otherwise a
    // single transient upstream failure would permanently wedge cold-start
    // until the Lambda recycled.
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 500,
        body: 'first attempt server error',
        contentType: 'text/plain',
      },
    ]);
    await expect(fetchAtlasMarkdownContent()).rejects.toThrow(/Failed to fetch latest commit metadata/);

    // Second attempt with healthy upstream — must actually run, not return
    // a stale rejected promise.
    const tarballBytes = fs.readFileSync(FIXTURE_TARBALL);
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('sha-recovered', 'recovered'),
        contentType: 'application/json',
      },
      {
        url: ATLAS_REPO_TARBALL_URL,
        status: 200,
        body: tarballBytes,
        contentType: 'application/gzip',
      },
    ]);
    const content = await fetchAtlasMarkdownContent();
    expect(content.length).toBeGreaterThan(0);
  });
});

describe('fetchAtlasMarkdownMetadata', () => {
  it('returns commit metadata without downloading the tarball', async () => {
    setupFetchMocks([
      {
        url: ATLAS_REPO_COMMITS_URL,
        status: 200,
        body: commitResponse('dddddddd', 'metadata-only'),
        contentType: 'application/json',
      },
    ]);
    const meta = await fetchAtlasMarkdownMetadata();
    expect(meta.commitSha).toBe('dddddddd');
    expect(fetchCallCount).toBe(1);
  });
});

describe('dev-mode fallback', () => {
  it('composes the vendored fixture in development without hitting the network', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'development');
    // Failing fetch — proves no network is touched.
    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called in dev mode when fixture exists');
    }) as unknown as typeof fetch;
    try {
      const expected = fs.readFileSync(FIXTURE_EXPECTED, 'utf8');
      const content = await loadAtlasMarkdownForSync();
      expect(content).toBe(expected);
    } finally {
      if (originalNodeEnv !== undefined) {
        vi.stubEnv('NODE_ENV', originalNodeEnv);
      }
      vi.unstubAllEnvs();
    }
  });
});
