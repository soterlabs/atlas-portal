import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANSWER_CONTEXT_POLICY,
  SNIPPET_BUDGET_CHARS,
  boundToExcerpts,
  parseAnswerContextPolicy,
} from '../context-policy';
import { answerSystemPrompt, buildAnswerUserPrompt } from '../prompt';

const FILLER = 'The remainder of this clause restates procedural context in unrelated terms. ';
const LONG_DOC =
  FILLER.repeat(12) +
  'Where the Atlas specifies a maximum exposure, actual exposure may exceed that maximum by up to 5%, provided the excess is solely attributable to accrued interest. ' +
  FILLER.repeat(12);

describe('parseAnswerContextPolicy', () => {
  it('accepts known policies and falls back to the shipped default otherwise', () => {
    expect(parseAnswerContextPolicy('bounded-snippet')).toBe('bounded-snippet');
    expect(parseAnswerContextPolicy('citations-only')).toBe('citations-only');
    expect(parseAnswerContextPolicy(undefined)).toBe(DEFAULT_ANSWER_CONTEXT_POLICY);
    expect(parseAnswerContextPolicy('snippets-please')).toBe(DEFAULT_ANSWER_CONTEXT_POLICY);
  });
});

describe('boundToExcerpts', () => {
  it('passes a document at or under the budget through whole', () => {
    const short = 'A short governing clause.';
    expect(boundToExcerpts(short, 'governing clause')).toEqual({ excerpts: [short], truncated: false });
  });

  it('windows around the matched terms and keeps the qualifier next to them', () => {
    const { excerpts, truncated } = boundToExcerpts(LONG_DOC, 'maximum exposure');
    expect(truncated).toBe(true);
    expect(excerpts.join('')).toContain('provided the excess is solely attributable');
    expect(excerpts.reduce((sum, excerpt) => sum + excerpt.length, 0)).toBeLessThanOrEqual(LONG_DOC.length);
  });

  it('every excerpt is a verbatim contiguous slice of the source', () => {
    for (const query of ['maximum exposure', 'accrued interest', 'no such words here at all']) {
      for (const excerpt of boundToExcerpts(LONG_DOC, query).excerpts) {
        expect(LONG_DOC.includes(excerpt)).toBe(true);
      }
    }
  });

  it('falls back to the head of the document when nothing matches', () => {
    const { excerpts, truncated } = boundToExcerpts(LONG_DOC, 'zebra quokka');
    expect(truncated).toBe(true);
    expect(LONG_DOC.startsWith(excerpts[0])).toBe(true);
    expect(excerpts[0].length).toBeLessThanOrEqual(SNIPPET_BUDGET_CHARS);
  });

  it('merges overlapping term windows instead of duplicating text', () => {
    const { excerpts } = boundToExcerpts(LONG_DOC, 'exposure exceed maximum');
    const joined = excerpts.join(' ');
    expect(joined.split('actual exposure may exceed').length).toBe(2);
  });
});

describe('policy-aware prompt rendering', () => {
  const doc = { docNo: 'A.1', name: 'Tolerance', breadcrumb: ['Scope'], text: LONG_DOC };
  const shortDoc = { docNo: 'A.2', name: 'Short', breadcrumb: ['Scope'], text: 'One clause only.' };

  it('full-document rendering is unchanged from SEARCH-25', () => {
    expect(buildAnswerUserPrompt('q', [shortDoc])).toBe(buildAnswerUserPrompt('q', [shortDoc], 'full-document'));
    expect(buildAnswerUserPrompt('q', [shortDoc])).toContain('### A.2 · Short\nLocation: Scope\nOne clause only.');
    expect(answerSystemPrompt('full-document')).toBe(answerSystemPrompt());
  });

  it('bounded-snippet renders short documents identically and long ones as marked excerpts', () => {
    const prompt = buildAnswerUserPrompt('maximum exposure', [doc, shortDoc], 'bounded-snippet');
    expect(prompt).toContain('Excerpt 1 of');
    expect(prompt).toContain('the document has more text than shown');
    expect(prompt).toContain('### A.2 · Short\nLocation: Scope\nOne clause only.');
    expect(answerSystemPrompt('bounded-snippet')).toContain('never guess at text that was omitted');
  });

  it('citations-only sends no document text', () => {
    const prompt = buildAnswerUserPrompt('maximum exposure', [doc], 'citations-only');
    expect(prompt).toContain('(Document text not provided.)');
    expect(prompt).not.toContain('accrued interest');
    expect(answerSystemPrompt('citations-only')).toContain('you must abstain');
  });
});
