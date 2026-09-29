/**
 * Prompt construction for cited answers (SEARCH-25), context-bounded per SEARCH-47.
 *
 * The template enforces the ticket's constraints at the instruction level (the verify
 * module enforces them again in code): quote normative text verbatim, one citation per
 * claim, and abstain — "not found in the retrieved documents" — rather than guess.
 */
import { type AnswerContextPolicy, DEFAULT_ANSWER_CONTEXT_POLICY, boundToExcerpts } from './context-policy';

export interface AnswerContextDocument {
  docNo: string;
  name: string;
  breadcrumb: string[];
  text: string;
}

/** Cap per-document text so 20 documents stay well inside the context budget. */
export const MAX_DOCUMENT_CHARS = 4000;

export const ANSWER_SYSTEM_PROMPT = `You answer questions about the Sky Atlas, a governance rulebook, using ONLY the documents provided in the request. Readers are often legal professionals; precision beats fluency.

Rules, all mandatory:
1. Every claim you make must be supported by a VERBATIM quote from one provided document — copy the passage exactly, character for character; never paraphrase inside "quote", never stitch two passages together, never quote fewer than a full clause.
2. Preserve every qualifier the source states (words like "provided that", "unless", "solely", "up to", "only if", percentages, amounts, deadlines). Dropping or weakening a qualifier is a wrong answer.
3. If the provided documents do not answer the question, abstain. Never use outside knowledge; never guess.
4. Prefer the document that states the governing rule over documents that merely mention the topic.
5. Keep claims short and declarative; the quotes carry the authority.`;

/**
 * Policy-specific rule appended to the system prompt (SEARCH-47). The excerpt rule is
 * the zvec-grep evidence rule adapted to a single-shot answerer: an excerpt is
 * already-read evidence, and there is no tool to open the rest of the document — so
 * the only honest response to insufficient excerpts is abstention.
 */
export const POLICY_RULES: Record<AnswerContextPolicy, string> = {
  'full-document': '',
  'bounded-snippet':
    '\n6. Some documents are provided as verbatim excerpts around the terms of the question. An excerpt is already-read source text: quote from it exactly as shown. If the shown text does not answer the question, abstain — never guess at text that was omitted.',
  'citations-only':
    '\n6. Document text is not provided in this request, only identifiers and names. A claim requires a verbatim quote from provided text, so you must abstain.',
};

export function answerSystemPrompt(policy: AnswerContextPolicy = DEFAULT_ANSWER_CONTEXT_POLICY): string {
  return `${ANSWER_SYSTEM_PROMPT}${POLICY_RULES[policy]}`;
}

export interface AnswerModelOutputShape {
  abstain: boolean;
  reason: string;
  claims: Array<{ text: string; quote: string; doc_no: string }>;
}

/** JSON schema for the provider's structured output (strict mode). */
export const ANSWER_OUTPUT_JSON_SCHEMA = {
  name: 'atlas_cited_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['abstain', 'reason', 'claims'],
    properties: {
      abstain: { type: 'boolean', description: 'true when the documents do not answer the question' },
      reason: {
        type: 'string',
        description: 'when abstaining: what is missing, in one sentence; otherwise an empty string',
      },
      claims: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'quote', 'doc_no'],
          properties: {
            text: { type: 'string', description: 'one short declarative statement answering part of the question' },
            quote: { type: 'string', description: 'the exact verbatim passage from the cited document' },
            doc_no: {
              type: 'string',
              description: 'the document number the quote comes from, e.g. A.2.2.10.1.1.1.2.1.7',
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Renders one document under the active policy. Full-document is byte-identical to the
 * SEARCH-25 rendering. A bounded document that fits its budget whole also renders
 * identically, so bounding only ever changes the long tail. Boundary markers are
 * header lines outside the sliced text — the slices stay verbatim, so any quote copied
 * from them verifies against the full corpus text.
 */
function renderDocument(query: string, doc: AnswerContextDocument, policy: AnswerContextPolicy): string {
  const header = `### ${doc.docNo} · ${doc.name}\nLocation: ${doc.breadcrumb.join(' › ')}`;
  if (policy === 'citations-only') return `${header}\n(Document text not provided.)`;
  if (policy === 'bounded-snippet') {
    const { excerpts, truncated } = boundToExcerpts(doc.text, query);
    if (!truncated) return `${header}\n${excerpts[0]}`;
    const blocks = excerpts
      .map(
        (excerpt, index) =>
          `Excerpt ${index + 1} of ${excerpts.length} (the document has more text than shown):\n${excerpt}`,
      )
      .join('\n');
    return `${header}\n${blocks}`;
  }
  const text = doc.text.length > MAX_DOCUMENT_CHARS ? `${doc.text.slice(0, MAX_DOCUMENT_CHARS)}…` : doc.text;
  return `${header}\n${text}`;
}

export function buildAnswerUserPrompt(
  query: string,
  documents: AnswerContextDocument[],
  policy: AnswerContextPolicy = DEFAULT_ANSWER_CONTEXT_POLICY,
): string {
  const rendered = documents.map((doc) => renderDocument(query, doc, policy)).join('\n\n');
  return `Question: ${query}\n\nProvided documents (the reader's current search results):\n\n${rendered}`;
}
