/**
 * Server-side configuration for the answer feature (SEARCH-25). One source of truth for
 * the route and the Atlas page — the SEARCH-23 lesson: the two must never disagree
 * about "configured".
 *
 * The provider selection and key deliberately reuse the query-rewrite config: one org,
 * one licensing decision, one key. Only the feature flag is this feature's own, so
 * answers can be enabled or disabled independently of the rewrite experiment.
 */
import { rewriteProviderApiKey, rewriteProviderName } from '@/app/server/search-query-rewrite/config';
import { type AnswerContextPolicy, parseAnswerContextPolicy } from './context-policy';

export { rewriteProviderApiKey as answerProviderApiKey, rewriteProviderName as answerProviderName };

/** Context policy for the route (SEARCH-47); unrecognised values fall back to the shipped default. */
export function answerContextPolicy(): AnswerContextPolicy {
  return parseAnswerContextPolicy(process.env.SEARCH_ANSWER_CONTEXT_POLICY);
}

/**
 * True when the answers flag is on AND the OpenAI provider is selected with a key. The
 * answer route only has an OpenAI implementation, so an Anthropic selection must keep
 * the feature off rather than mount a control that sends the wrong key to OpenAI.
 */
export function searchAnswersConfigured(): boolean {
  return (
    process.env.SEARCH_ANSWERS_ENABLED === 'true' &&
    rewriteProviderName() === 'openai' &&
    rewriteProviderApiKey().length > 0
  );
}
