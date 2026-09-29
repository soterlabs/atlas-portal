/**
 * POST /api/search/answer (SEARCH-25): a cited, mechanically verified answer over the
 * reader's current results. Fail-closed at every layer: flag + key gating, same-origin,
 * JSON media type, bounded body, per-client and global rate limits, and the service's
 * quote verification — an unverifiable answer degrades to an explicit failure, never to
 * unverified prose.
 */
import { flattenAtlasDocuments } from '@/app/atlas/search/flatten-documents';
import { loadAtlasPortalData } from '@/app/server/atlas/load-atlas-portal-data';
import { RequestRateLimiter } from '@/app/server/request-rate-limit';
import { answerContextPolicy, answerProviderApiKey, searchAnswersConfigured } from '@/app/server/search-answer/config';
import type { AnswerContextDocument } from '@/app/server/search-answer/prompt';
import { AnswerProviderError, OpenAiAnswerProvider } from '@/app/server/search-answer/provider';
import { AnswerOutputError, SearchAnswerService } from '@/app/server/search-answer/service';
import { SearchAnswerValidationError, parseSearchAnswerRequest } from '@/app/shared/search-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
// Answers cost more than rewrites; keep the anonymous budget tighter.
const rateLimiter = new RequestRateLimiter({ perClient: 6, global: 60 });
let singleton: { key: string; service: SearchAnswerService } | null = null;

/**
 * doc_no → context document, resolved against the ISR-cached corpus. The flattened
 * lookup map is memoised per tree identity — resolveDocument is called once per
 * requested document, and re-flattening 11k documents each time would multiply the
 * request cost by the context size.
 */
let flattenCache: { trees: unknown; byDocNo: Map<string, AnswerContextDocument> } | null = null;

async function resolveDocument(docNo: string): Promise<AnswerContextDocument | undefined> {
  const { exportScopeTrees } = await loadAtlasPortalData();
  if (!flattenCache || flattenCache.trees !== exportScopeTrees) {
    const byDocNo = new Map<string, AnswerContextDocument>();
    for (const doc of flattenAtlasDocuments(exportScopeTrees)) {
      byDocNo.set(doc.doc_no, { docNo: doc.doc_no, name: doc.name, breadcrumb: doc.breadcrumb, text: doc.content });
    }
    flattenCache = { trees: exportScopeTrees, byDocNo };
  }
  return flattenCache.byDocNo.get(docNo);
}

function configuredService(apiKey: string): SearchAnswerService {
  // The policy is part of the singleton key so a config change replaces the service
  // (and its response cache) instead of leaking answers across policies.
  const contextPolicy = answerContextPolicy();
  const key = `${apiKey}\u0000${contextPolicy}`;
  if (!singleton || singleton.key !== key) {
    singleton = {
      key,
      service: new SearchAnswerService({
        provider: new OpenAiAnswerProvider({ apiKey }),
        resolveDocument,
        contextPolicy,
      }),
    };
  }
  return singleton.service;
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetches may omit the header
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!searchAnswersConfigured()) return json({ error: 'answers are not enabled' }, 503);
  if (!sameOrigin(request)) return json({ error: 'cross-origin requests are not allowed' }, 403);
  if (!/^application\/json\b/.test(request.headers.get('content-type') ?? '')) {
    return json({ error: 'content-type must be application/json' }, 415);
  }

  const decision = rateLimiter.check(clientKey(request));
  if (!decision.allowed) {
    return json({ error: 'rate limited' }, 429, { 'retry-after': String(decision.retryAfterSeconds) });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: 'request too large' }, 413);

  try {
    const parsed = parseSearchAnswerRequest(JSON.parse(raw));
    const { response } = await configuredService(answerProviderApiKey()).answer(parsed);
    return json(response, 200);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SearchAnswerValidationError) {
      return json({ error: 'invalid request' }, 400);
    }
    if (error instanceof AnswerOutputError) {
      // Explicit, honest failure: the model's answer did not verify, so there is none.
      return json({ error: 'no verifiable answer', reason: error.reason }, 502);
    }
    if (error instanceof AnswerProviderError) {
      return json({ error: 'answer provider unavailable' }, error.kind === 'configuration' ? 503 : 502);
    }
    return json({ error: 'internal error' }, 500);
  }
}
