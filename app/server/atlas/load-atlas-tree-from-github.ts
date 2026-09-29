/**
 * Tarball+compose loader for the Atlas content tree.
 *
 * Replaces the older direct-fetch of `Sky Atlas/Sky Atlas.md`. After the
 * Atomic Atlas cutover (sky-ecosystem/next-gen-atlas#236), the monolith file
 * no longer exists in the repo — instead, each document lives at
 * `content/<doc-no>/document.md` and the portal composes them back together
 * server-side.
 *
 * Flow:
 *   1. GET /repos/{owner}/{repo}/commits/{branch} → latest commit SHA + date.
 *   2. If SHA matches the last cached compose, return the cached monolith.
 *   3. Otherwise: GET /repos/{owner}/{repo}/tarball/{branch} → extract to /tmp.
 *   4. Detect the Atlas layout in the extracted content/ directory and compose
 *      it — atomized trees are walked by `compose()`, consolidated ("Option C")
 *      checkouts are concatenated by `reassemble()`. Both produce the identical
 *      monolith, so this file is layout-agnostic past `loadComposed()`.
 *   5. Cache the composed result keyed by SHA.
 *
 * Public API surface preserved (so the rest of the portal — atlas-json-exporter,
 * load-atlas-portal-data, and the truncated-atlas script — doesn't change):
 *   - fetchAtlasMarkdownContent(): Promise<string>
 *   - fetchAtlasMarkdownMetadata(): Promise<{ lastModified, commitSha, commitMessage }>
 *   - loadAtlasMarkdownFromGitHub(): Promise<AtlasMarkdownFromGitHub>
 *   - loadAtlasMarkdownForSync(): Promise<string>  (dev fallback uses fixture)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import { ATOMIZED, bucketFromFilename, detectLayout, loadComposed, resolveAtlasRoot } from './atlas-source';
import { ATLAS_REPO_COMMITS_URL, ATLAS_REPO_REF, ATLAS_REPO_TARBALL_URL } from './constants';

export interface AtlasMarkdownFromGitHub {
  /** The composed markdown content (Sky Atlas monolith). */
  content: string;
  /** The last modified date of the canonical branch (latest commit date). */
  lastModified: Date;
  /** The SHA of the latest commit on the canonical branch. */
  commitSha: string;
  /** The commit message of the latest commit. */
  commitMessage: string;
}

interface AtlasCommitMetadata {
  lastModified: Date;
  commitSha: string;
  commitMessage: string;
}

interface GitHubCommitResponse {
  sha: string;
  commit: {
    message: string;
    committer: { date: string };
  };
}

// ---------------------------------------------------------------------------
// In-memory SHA-keyed compose cache
//
// Persists across requests within a single Vercel/Node process. Combined with
// the page-level revalidate=3600 and Next.js fetch-cache (which we ALSO opt
// into via { next: { revalidate: 3600 } } on each fetch), this gives us a
// two-tier cache: Next data cache short-circuits most fetches, and when fetch
// IS made, this in-process cache short-circuits the tarball download +
// extract + compose work for any SHA we've already composed.
// ---------------------------------------------------------------------------

interface CacheEntry {
  sha: string;
  content: string;
  metadata: AtlasCommitMetadata;
}

let composeCache: CacheEntry | null = null;

/**
 * Refresh policy for the in-memory cache.
 *
 * The hot path always serves `composeCache.content` if populated. A background
 * refresh runs at most once per `REFRESH_INTERVAL_MS`; on failure, the next
 * attempt is shortened to `FAILURE_RETRY_MS` so we recover from a transient
 * upstream issue without waiting a full interval. The cache is preserved
 * across failed refreshes — the user always sees the last-successful content.
 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_RETRY_MS = 5 * 60 * 1000; // 5 min after a failed refresh
let nextRefreshAt = 0;
let refreshInProgress = false;

/**
 * Cold-start coalescing: when the cache is empty and many requests arrive
 * concurrently (typical for Vercel cold-starts), serialize them onto a single
 * in-flight fetch instead of letting each spawn its own
 * download+extract+compose. Without this, N concurrent cold-start requests
 * each create a fresh `/tmp/atlas-tarball-*` (each ~13MB compressed,
 * substantially larger extracted), and Vercel's 512MB `/tmp` exhausts under
 * load — producing ENOSPC errors that 500 every subsequent request on the
 * same Lambda instance.
 *
 * Reference incident: 2026-05-07, sha 21da511 + b3bcec3 in production.
 */
let coldStartFetch: Promise<CacheEntry> | null = null;

/** For tests: clear the in-memory compose cache and refresh schedule. */
export function _clearAtlasComposeCache(): void {
  composeCache = null;
  nextRefreshAt = 0;
  refreshInProgress = false;
  coldStartFetch = null;
}

/**
 * Background refresh: re-fetch metadata + tarball if the refresh interval has
 * elapsed. Called fire-and-forget from the public read functions; the user
 * request never awaits this.
 *
 * On success: cache updated (if SHA changed); next refresh scheduled in
 * REFRESH_INTERVAL_MS.
 *
 * On failure: cache preserved (user keeps seeing last-known-good); next
 * attempt scheduled in FAILURE_RETRY_MS.
 */
async function refreshComposeCacheIfStale(): Promise<void> {
  if (refreshInProgress) return;
  if (Date.now() < nextRefreshAt) return;
  refreshInProgress = true;
  try {
    const metadata = await fetchLatestCommitMetadata();
    if (composeCache === null || composeCache.sha !== metadata.commitSha) {
      console.log(
        `[loadAtlasTree] refresh: composing from tarball at ref=${ATLAS_REPO_REF.slice(0, 12)} sha=${metadata.commitSha.slice(0, 8)}`,
      );
      const content = await composeFromTarball();
      composeCache = { sha: metadata.commitSha, content, metadata };
    }
    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (err) {
    console.warn(`[loadAtlasTree] background refresh failed (${(err as Error).message}); cache preserved, will retry`);
    nextRefreshAt = Date.now() + FAILURE_RETRY_MS;
  } finally {
    refreshInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// GitHub API: latest commit metadata
// ---------------------------------------------------------------------------

function githubAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'atlas-portal',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return headers;
}

/**
 * Fetch the latest commit on the canonical branch.
 *
 * Uses Next.js fetch caching with revalidate=3600 (matches page-level ISR
 * window — Adam's directive: "keep it as is because a change only takes place
 * once a week generally").
 */
async function fetchLatestCommitMetadata(): Promise<AtlasCommitMetadata> {
  const response = await fetch(ATLAS_REPO_COMMITS_URL, {
    headers: githubAuthHeaders(),
    next: { revalidate: 3600 },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch latest commit metadata from GitHub: ${response.status} ${response.statusText}`);
  }
  const commit = (await response.json()) as GitHubCommitResponse;
  if (!commit || !commit.sha) {
    throw new Error('GitHub /commits response missing sha');
  }
  return {
    lastModified: new Date(commit.commit.committer.date),
    commitSha: commit.sha,
    commitMessage: commit.commit.message,
  };
}

// ---------------------------------------------------------------------------
// Tarball: download → extract → locate content/
// ---------------------------------------------------------------------------

/**
 * Download the repo tarball for the canonical branch and extract into a
 * fresh temp directory. Returns the absolute path to the extracted root.
 *
 * GitHub tarballs unpack into a single top-level folder named
 * `{owner}-{repo}-{shortsha}/`. The caller must locate `content/` inside.
 */
async function downloadAndExtractTarball(): Promise<string> {
  // Note: NOT using Next.js `next: { revalidate }` here. Next's data cache
  // rejects items >2MB and the Atlas tarball is currently ~13MB. The
  // in-memory SHA cache (above) handles invalidation; the tarball is only
  // re-fetched when the upstream commit SHA actually changes.
  const response = await fetch(ATLAS_REPO_TARBALL_URL, {
    headers: githubAuthHeaders(),
    cache: 'no-store',
    // Follow GitHub's 302 redirect to codeload automatically (default for fetch).
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch repo tarball from GitHub: ${response.status} ${response.statusText}`);
  }
  if (response.body === null) {
    throw new Error('GitHub tarball response had no body');
  }

  // Defense in depth: scrub any leftover atlas-tarball-* dirs from prior
  // crashed runs. The composeFromTarball() finally block normally cleans up,
  // but if a process is killed mid-extraction (timeout, OOM) the dir leaks.
  // On Vercel, Lambda /tmp persists across invocations on a warm instance, so
  // a single mid-extraction kill can permanently leak ~13MB until the
  // instance recycles. Cheap to scan (typically zero entries).
  await scrubLeftoverTarballs();

  // Use a per-call temp dir so concurrent extractions don't clobber each other.
  // Vercel's serverless filesystem allows writes under /tmp.
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-tarball-'));

  // Stream the gzipped tar through gunzip into tar.extract.
  const nodeStream = Readable.fromWeb(response.body as never);
  await pipeline(nodeStream, createGunzip(), tar.extract({ cwd: dest }));

  return dest;
}

/**
 * Scrub leftover `/tmp/atlas-tarball-*` directories from prior crashed runs.
 *
 * Defense in depth — `composeFromTarball()`'s finally block normally cleans
 * up after itself, but mid-extraction kills (timeout, OOM, container
 * recycle) skip that finally and leak the temp dir. On Vercel, /tmp persists
 * across invocations on a warm Lambda, so leaked dirs accumulate until the
 * instance recycles. This scrub runs once per extraction at near-zero cost
 * when /tmp is clean (just a directory listing).
 */
async function scrubLeftoverTarballs(): Promise<void> {
  const tmpRoot = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return; // /tmp unreadable — nothing we can do.
  }
  const stale = entries.filter((e) => e.isDirectory() && e.name.startsWith('atlas-tarball-'));
  if (stale.length === 0) return;
  console.warn(`[loadAtlasTree] scrubbing ${stale.length} leftover atlas-tarball-* dir(s) from /tmp`);
  await Promise.all(
    stale.map((e) =>
      fsp.rm(path.join(tmpRoot, e.name), { recursive: true, force: true }).catch(() => {
        /* ignore */
      }),
    ),
  );
}

/**
 * Find the extracted top-level repo folder inside `extractRoot`.
 * GitHub tarballs unpack to exactly one top-level folder.
 */
async function findExtractedRepoRoot(extractRoot: string): Promise<string> {
  const entries = await fsp.readdir(extractRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(
      `Expected exactly one top-level folder inside extracted tarball, found ${dirs.length}: ` +
        `${dirs.map((d) => d.name).join(', ')}`,
    );
  }
  return path.join(extractRoot, dirs[0].name);
}

/**
 * Sanity floor: catch the empty/near-empty case where compose returns 0 or
 * near-0 bytes (e.g., truncated tarball, partial extract). Without this
 * guard, an empty value can be cached and served indefinitely. Threshold of
 * 100 bytes catches that without breaking tests that use small fixture
 * tarballs.
 *
 * (For production, the live Atlas is ~3.4 MB; the rawTotal check in
 * validateCompleteness catches the partial-fetch case at the doc-count
 * level too.)
 */
const COMPOSE_OUTPUT_MIN_BYTES = 100;

/** Sanity floor: at least 1 source file must be present (catches empty extract). */
const CONTENT_DIR_MIN_FILES = 1;

/**
 * Recursively count `document.md` files under a directory.
 * Used as a sanity check post-extraction of an atomized tree.
 */
function countDocumentMdFiles(dir: string): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'document.md') {
      count += 1;
    } else if (entry.isDirectory()) {
      count += countDocumentMdFiles(path.join(dir, entry.name));
    }
  }
  return count;
}

/**
 * Count consolidated Atlas bucket files (`<docNo> - <name>.md`) directly under
 * `dir`. The consolidated-layout counterpart of `countDocumentMdFiles` — same
 * job, catching a truncated extract before the compose result poisons the cache.
 */
function countBucketFiles(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((e) => e.isFile() && bucketFromFilename(e.name) !== null).length;
}

/**
 * Compose the Atlas monolith by downloading the latest tarball and walking
 * its `content/` tree.
 *
 * Includes sanity checks at each stage. If any returns an unexpectedly small
 * result, throws — preventing the in-memory cache from being poisoned with
 * a partial/empty value.
 */
async function composeFromTarball(): Promise<string> {
  const extractRoot = await downloadAndExtractTarball();
  try {
    const repoRoot = await findExtractedRepoRoot(extractRoot);
    const contentDir = path.join(repoRoot, 'content');
    if (!fs.existsSync(contentDir)) {
      throw new Error(`Extracted tarball does not contain content/ at ${contentDir}`);
    }

    // Which layout did we just extract? Throws (rather than composing to an
    // empty string) when the tree matches neither layout — an empty result is
    // indistinguishable from a legitimate pre-cutover ref, so it must not be
    // allowed to reach the cache.
    const layout = detectLayout(contentDir);
    const sourceKind = layout === ATOMIZED ? 'document.md' : 'consolidated .md';

    // Sanity: count source files BEFORE compose. If extraction was partial,
    // we want to know that here, not after the empty compose result poisons
    // the cache.
    const sourceCount = layout === ATOMIZED ? countDocumentMdFiles(contentDir) : countBucketFiles(contentDir);
    console.log(`[loadAtlasTree] extracted ${sourceCount} ${sourceKind} files from tarball (layout=${layout})`);
    if (sourceCount < CONTENT_DIR_MIN_FILES) {
      throw new Error(
        `Atlas content extraction sanity-check failed: only ${sourceCount} ${sourceKind} files found ` +
          `(expected ≥ ${CONTENT_DIR_MIN_FILES}). Tarball extraction likely truncated or failed.`,
      );
    }

    const composed = loadComposed(contentDir);
    if (composed.length < COMPOSE_OUTPUT_MIN_BYTES) {
      throw new Error(
        `Atlas compose output sanity-check failed: ${composed.length} bytes ` +
          `(expected ≥ ${COMPOSE_OUTPUT_MIN_BYTES}). Tree walk produced unexpectedly small output.`,
      );
    }
    console.log(`[loadAtlasTree] composed monolith: ${composed.length} bytes`);

    return composed;
  } finally {
    // Best-effort cleanup. /tmp is auto-purged by Vercel between cold starts.
    try {
      await fsp.rm(extractRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Local dev override: read Atlas content from disk instead of GitHub
//
// When ATLAS_LOCAL_CONTENT is set (dev only — ignored in production), the
// portal composes the Atlas monolith from a local path instead of downloading
// the repo tarball. The path may point at either:
//   - an Atlas content directory in EITHER layout — an atomized tree containing
//     A/ and NR/, or a consolidated directory of `<docNo> - <name>.md` files,
//     or a repo root containing either under content/ — composed via
//     loadComposed(), exactly like the tarball path, or
//   - a single pre-composed monolith .md file — read verbatim.
//
// This lets `npm run dev` run fully offline against a local checkout of
// sky-ecosystem/next-gen-atlas without spending GitHub API rate limit on every
// cold start / refresh. Set it in .env.local, e.g.:
//   ATLAS_LOCAL_CONTENT=/abs/path/to/next-gen-atlas/content
// ---------------------------------------------------------------------------

/**
 * Resolve the configured local-content path, or null to fall through to
 * GitHub. Honored only outside production; warns (once per call site) if set
 * in a production build so it can't silently serve stale local content.
 */
function localContentPath(): string | null {
  const localPath = process.env.ATLAS_LOCAL_CONTENT;
  if (!localPath) return null;
  if (process.env.NODE_ENV === 'production') {
    console.warn('[loadAtlasTree] ATLAS_LOCAL_CONTENT is set but ignored in production; fetching from GitHub.');
    return null;
  }
  return localPath;
}

/**
 * Compose the monolith from the local override path, or return null if no
 * override is configured. A directory is composed (accepting either the
 * content/ dir itself or a repo root containing one); a file is read verbatim.
 */
function loadLocalAtlasOverride(): string | null {
  const localPath = localContentPath();
  if (!localPath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(localPath);
  } catch {
    throw new Error(`ATLAS_LOCAL_CONTENT points to a path that does not exist: ${localPath}`);
  }

  if (stat.isDirectory()) {
    const contentDir = resolveAtlasRoot(localPath);
    console.log(`[loadAtlasTree] ATLAS_LOCAL_CONTENT set — composing from local dir: ${contentDir}`);
    return loadComposed(contentDir);
  }

  console.log(`[loadAtlasTree] ATLAS_LOCAL_CONTENT set — reading local monolith file: ${localPath}`);
  return fs.readFileSync(localPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cold-start compose, coalesced across concurrent callers.
 *
 * If a cold-start fetch is already in flight, awaiters share the same
 * promise. This is critical: without coalescing, N concurrent first
 * requests on a fresh Lambda each spawn their own ~13MB tarball download
 * and extraction into a fresh `/tmp/atlas-tarball-*`, exhausting `/tmp`
 * (Vercel limit ~512MB) and pushing every subsequent request on that
 * Lambda into ENOSPC 500s.
 *
 * Returns the populated CacheEntry so callers can read either the
 * composed content or the metadata.
 */
async function coldStartCompose(): Promise<CacheEntry> {
  if (coldStartFetch !== null) {
    return coldStartFetch;
  }
  coldStartFetch = (async (): Promise<CacheEntry> => {
    try {
      const metadata = await fetchLatestCommitMetadata();
      console.log(
        `[loadAtlasTree] cold-start compose at ref=${ATLAS_REPO_REF.slice(0, 12)} sha=${metadata.commitSha.slice(0, 8)}`,
      );
      const content = await composeFromTarball();
      const entry: CacheEntry = { sha: metadata.commitSha, content, metadata };
      composeCache = entry;
      nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
      return entry;
    } finally {
      coldStartFetch = null;
    }
  })();
  return coldStartFetch;
}

/**
 * Fetch the composed Atlas monolith content from GitHub.
 *
 * **Cache policy**: when the in-memory cache is populated, return it
 * immediately and trigger a fire-and-forget background refresh (subject to
 * the refresh interval). User requests never await an upstream fetch on the
 * hot path. When the cache is empty (cold start), fetch synchronously to
 * populate it — concurrent cold-start callers share a single in-flight
 * fetch via `coldStartCompose()`.
 */
export async function fetchAtlasMarkdownContent(): Promise<string> {
  const local = loadLocalAtlasOverride();
  if (local !== null) return local;
  if (composeCache !== null) {
    void refreshComposeCacheIfStale();
    return composeCache.content;
  }
  const entry = await coldStartCompose();
  return entry.content;
}

/**
 * Fetch metadata about the latest commit on the canonical branch.
 *
 * After the cutover the relevant commit is "latest commit on the branch"
 * rather than "latest commit that touched Sky Atlas/Sky Atlas.md" — there is
 * no longer a single file to scope to.
 */
export async function fetchAtlasMarkdownMetadata(): Promise<AtlasCommitMetadata> {
  const localPath = localContentPath();
  if (localPath !== null) {
    let lastModified: Date;
    try {
      lastModified = fs.statSync(localPath).mtime;
    } catch {
      lastModified = new Date(0);
    }
    return {
      lastModified,
      commitSha: 'local',
      commitMessage: 'Local ATLAS_LOCAL_CONTENT override',
    };
  }
  return fetchLatestCommitMetadata();
}

/**
 * Fetch both content and metadata of the Atlas monolith.
 *
 * Same cache policy as `fetchAtlasMarkdownContent`: serve from cache when
 * populated, otherwise share the in-flight cold-start fetch with all
 * concurrent callers.
 */
export async function loadAtlasMarkdownFromGitHub(): Promise<AtlasMarkdownFromGitHub> {
  const local = loadLocalAtlasOverride();
  if (local !== null) {
    const { lastModified, commitSha, commitMessage } = await fetchAtlasMarkdownMetadata();
    return { content: local, lastModified, commitSha, commitMessage };
  }
  if (composeCache !== null) {
    void refreshComposeCacheIfStale();
    return { content: composeCache.content, ...composeCache.metadata };
  }
  const entry = await coldStartCompose();
  return { content: entry.content, ...entry.metadata };
}

/**
 * Loads Atlas markdown for sync scripts.
 *
 * In local development (NODE_ENV !== 'production'), composes from the
 * vendored fixture at `tests/fixtures/atlas-content/` if it exists, falling
 * back to GitHub. In production, always fetches from GitHub.
 */
export async function loadAtlasMarkdownForSync(): Promise<string> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'atlas-content');
    try {
      const stat = await fsp.stat(fixturePath);
      if (stat.isDirectory()) {
        console.log(`[loadAtlasMarkdownForSync] Composing local fixture: ${fixturePath}`);
        return loadComposed(fixturePath);
      }
    } catch {
      console.warn(`[loadAtlasMarkdownForSync] Fixture not found (${fixturePath}), falling back to GitHub`);
    }
  }

  console.log('[loadAtlasMarkdownForSync] Fetching Atlas markdown from GitHub (tarball+compose)');
  return fetchAtlasMarkdownContent();
}

/**
 * Compute a stable hash of a string — used by tests/diagnostics.
 */
export function _hashContent(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}
