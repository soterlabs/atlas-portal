import { rewriteProviderApiKey, rewriteProviderName } from '@/app/server/search-query-rewrite/config';
import { OpenAiQueryRewriteProvider } from '@/app/server/search-query-rewrite/openai-provider';
import { AnthropicQueryRewriteProvider, QueryRewriteProviderError } from '@/app/server/search-query-rewrite/provider';
import { QueryRewriteRateLimiter } from '@/app/server/search-query-rewrite/rate-limit';
import { QueryRewriteOutputError, QueryRewriteService } from '@/app/server/search-query-rewrite/service';
import { QueryRewriteValidationError, parseQueryRewriteRequest } from '@/app/shared/search-query-rewrite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
const rateLimiter = new QueryRewriteRateLimiter();
let singleton: { key: string; service: QueryRewriteService } | null = null;

interface RewriteRouteDependencies {
  enabled: boolean;
  apiKey: string;
  rateLimiter: Pick<QueryRewriteRateLimiter, 'check'>;
  service?: QueryRewriteService;
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function configuredService(apiKey: string): QueryRewriteService {
  const provider = rewriteProviderName();
  const singletonKey = `${provider}:${apiKey}`;
  if (!singleton || singleton.key !== singletonKey) {
    singleton = {
      key: singletonKey,
      service: new QueryRewriteService(
        provider === 'anthropic'
          ? new AnthropicQueryRewriteProvider({ apiKey })
          : new OpenAiQueryRewriteProvider({ apiKey }),
      ),
    };
  }
  return singleton.service;
}

function isJsonMediaType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? '';
  return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

function hasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

/** Exported for route-level tests without mutating process env or making network calls. */
export async function handleQueryRewrite(request: Request, dependencies: RewriteRouteDependencies): Promise<Response> {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return json({ error: 'Cross-site requests are not allowed' }, 403);
  if (!hasAllowedOrigin(request)) return json({ error: 'Cross-origin requests are not allowed' }, 403);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  if (!isJsonMediaType(request.headers.get('content-type'))) {
    return json({ error: 'Content-Type must be application/json' }, 415);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'Request body is too large' }, 413);
  }
  if (!dependencies.enabled) return json({ error: 'Query rewriting is not enabled' }, 503);
  if (!dependencies.apiKey.trim() && !dependencies.service) {
    return json({ error: 'Query rewriting is not configured' }, 503);
  }

  let body: unknown;
  try {
    const raw = await readBoundedBody(request);
    if (raw === null) return json({ error: 'Request body is too large' }, 413);
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }

  try {
    const parsed = parseQueryRewriteRequest(body);
    // Invalid requests never consume a paid-call allowance, but every valid request is
    // checked immediately before it can reach the provider.
    const rate = dependencies.rateLimiter.check(clientKey(request));
    if (!rate.allowed) {
      return json({ error: 'Too many query rewrite requests' }, 429, {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }
    const result = await (dependencies.service ?? configuredService(dependencies.apiKey)).rewrite(parsed);
    return json(result, 200);
  } catch (error) {
    if (error instanceof QueryRewriteValidationError) return json({ error: error.message }, 400);
    if (error instanceof QueryRewriteOutputError) return json({ error: 'Query rewrite returned unusable output' }, 502);
    if (error instanceof QueryRewriteProviderError) {
      const status = error.kind === 'timeout' ? 504 : error.kind === 'configuration' ? 503 : 502;
      return json({ error: error.message }, status);
    }
    return json({ error: 'Query rewrite failed' }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleQueryRewrite(request, {
    enabled: process.env.QUERY_REWRITE_ENABLED === 'true',
    apiKey: rewriteProviderApiKey(),
    rateLimiter,
  });
}
