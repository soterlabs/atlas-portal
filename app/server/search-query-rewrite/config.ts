/**
 * Server-side configuration for the query-rewrite feature (SEARCH-23): which provider
 * is selected and whether the feature is actually usable. One source of truth for the
 * route (which serves the calls) and the Atlas page (which decides whether to render
 * the Ask button) — the two must never disagree about "configured".
 */

/** 'openai' (gpt-5.6-luna, the licensing default) or 'anthropic' (claude-opus-5). */
export type RewriteProviderName = 'openai' | 'anthropic';

export function rewriteProviderName(): RewriteProviderName {
  return process.env.QUERY_REWRITE_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
}

/** The API key for the selected provider, or '' when absent. */
export function rewriteProviderApiKey(): string {
  const key = rewriteProviderName() === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  return key?.trim() ?? '';
}

/** True when the feature flag is on AND the selected provider has a key. */
export function queryRewriteConfigured(): boolean {
  return process.env.QUERY_REWRITE_ENABLED === 'true' && rewriteProviderApiKey().length > 0;
}
