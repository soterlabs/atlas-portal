// Compatibility name for the SEARCH-23 query-rewrite route and its tests. The
// implementation is shared with other bounded anonymous server work.
export { RequestRateLimiter as QueryRewriteRateLimiter } from '@/app/server/request-rate-limit';
export type { RateLimitDecision } from '@/app/server/request-rate-limit';
