import type { Metadata } from 'next';
import { loadAtlasPortalData } from '@/app/server/atlas/load-atlas-portal-data';
import { searchAnswersConfigured } from '@/app/server/search-answer/config';
import { queryRewriteConfigured } from '@/app/server/search-query-rewrite/config';
import AtlasPagePrerendered from './atlas-page-prerendered';

// Force the route static so Vercel's CDN absorbs transient render-path
// failures (cold-start ENOSPC, GitHub timeout, parse hiccup) instead of
// surfacing them as user-visible HTTP 500/0. Without this, Next.js treats
// the route as dynamic because `load-atlas-tree-from-github.ts` fetches
// the GitHub tarball with `cache: 'no-store'` (forced — the 13 MB tarball
// exceeds Next's 2 MB data-cache limit), and any direct `no-store` fetch
// marks the consuming route dynamic. With `force-static`, the route is
// pre-rendered at build time + ISR-revalidated hourly — the no-store
// fetch still runs at revalidation time, but the user never sees its
// hiccups because Vercel keeps serving the last-known-good static HTML.
// Mirrors the working `/proposal` pattern. See investigation note at
// ~/projects/atlas-portal-static-cache-investigation.md for context.
export const dynamic = 'force-static';
// Revalidate every hour — ISR serves cached page instantly,
// rebuilds in background when stale. No manual deploy needed.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Sky Atlas',
  description: '',
};

export default async function Page() {
  const { exportScopeTrees, uuidMappings } = await loadAtlasPortalData();

  return (
    <AtlasPagePrerendered
      exportScopeTreesWithoutAgents={exportScopeTrees}
      uuidMappings={uuidMappings}
      queryRewriteEnabled={queryRewriteConfigured()}
      answersEnabled={searchAnswersConfigured()}
    />
  );
}
