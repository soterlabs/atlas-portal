/**
 * Prompt construction, response parsing and the mechanical leak check for SEARCH-17's
 * doc2query generation. Pure functions — no network — so every rule here is unit-tested.
 *
 * Guard rails:
 * - the paraphrase must preserve qualifiers ("provided that", "solely", "unless") — the
 *   prompt demands it and a human sample review enforces it;
 * - the expansion may not introduce numbers or document numbers absent from the source —
 *   `findLeaks` enforces that mechanically, and a leaking entry is rejected.
 */
import type { FlatAtlasDocument } from '../../app/atlas/search/flatten-documents';

export const EXPANSION_WORD_LIMIT = 120;

export interface ExpansionInput {
  doc: FlatAtlasDocument;
  /** Body of the parent document, when it has one — context for instance documents. */
  parentContent?: string;
}

export function buildPrompt({ doc, parentContent }: ExpansionInput): string {
  const parts = [
    `You are indexing a governance rulebook (the Sky Atlas) for search. Readers use everyday`,
    `words ("cap", "limit", "penalty", "who can…"), while the Atlas uses its own terms`,
    `("tolerance", "derecognition"). Write search-expansion text for the document below.`,
    ``,
    `Document number: ${doc.doc_no}`,
    `Title: ${doc.name}`,
    `Type: ${doc.type}`,
    `Location: ${doc.breadcrumb.join(' › ')}`,
    doc.extras ? `Fields:\n${doc.extras}` : null,
    `Body:\n${doc.content || '(empty)'}`,
    parentContent ? `Parent document body (context only — do not paraphrase it):\n${parentContent}` : null,
    ``,
    `Return ONLY a JSON object, no other text:`,
    `{"paraphrase": "...", "questions": ["...", "..."]}`,
    ``,
    `Rules:`,
    `1. paraphrase: 1-2 plain-language sentences saying what this document establishes, using`,
    `   the words a reader would type, not the Atlas's. If the body states a rule with`,
    `   qualifiers or conditions ("provided that", "solely", "unless", "up to"), every`,
    `   qualifier MUST be preserved — never weaken or drop one.`,
    `2. questions: 2-3 questions a governance participant would type into search to find`,
    `   exactly this document. Vary the vocabulary away from the document's own words.`,
    `3. Never introduce facts, numbers, amounts, dates or document numbers that are not in`,
    `   the text above. Never name entities (Primes, roles, tokens) the text does not name.`,
    `4. At most ${EXPANSION_WORD_LIMIT} words in total across paraphrase and questions.`,
    `5. For a near-empty or purely structural document, describe what its location says it`,
    `   is (e.g. "the contract addresses for X under Y") — still without inventing facts.`,
  ];
  return parts.filter((part) => part !== null).join('\n');
}

export interface ParsedExpansion {
  paraphrase: string;
  questions: string[];
}

/** Parses the model's reply: the first JSON object found, validated for shape. */
export function parseExpansionResponse(text: string): ParsedExpansion {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');

  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ParsedExpansion>;
  if (typeof parsed.paraphrase !== 'string' || !parsed.paraphrase.trim()) {
    throw new Error('missing paraphrase');
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.some((question) => typeof question !== 'string')) {
    throw new Error('missing questions');
  }
  const paraphrase = parsed.paraphrase.trim();
  const questions = parsed.questions.map((question) => question.trim()).filter(Boolean);
  if (questions.length === 0) throw new Error('empty questions');

  const words = [paraphrase, ...questions].join(' ').split(/\s+/).length;
  if (words > EXPANSION_WORD_LIMIT * 1.5) throw new Error(`expansion too long: ${words} words`);

  return { paraphrase, questions };
}

const NUMBER = /\d[\d,.]*%?/g;
const DOC_NUMBER = /\b[A-Za-z]+(?:\.\w+)+\b/g;

/**
 * Mechanical leak check: numbers and document-number-like tokens in the expansion must
 * appear in the source text (body, name, extras, breadcrumb, parent context). Returns
 * the offending tokens; an entry with leaks is rejected, not shipped.
 */
export function findLeaks(expansion: ParsedExpansion, input: ExpansionInput): string[] {
  const source = [
    input.doc.name,
    input.doc.content,
    input.doc.extras,
    input.doc.breadcrumb.join(' '),
    input.doc.doc_no,
    input.parentContent ?? '',
  ]
    .join(' ')
    .toLowerCase();

  const text = [expansion.paraphrase, ...expansion.questions].join(' ');
  const candidates = [...(text.match(NUMBER) ?? []), ...(text.match(DOC_NUMBER) ?? [])]
    // The greedy number pattern can swallow sentence punctuation ("2," in "2, and") —
    // trim it so a bare in-source number is not flagged for its trailing comma.
    .map((token) => token.replace(/[.,]+$/, ''))
    .filter(Boolean);

  return Array.from(new Set(candidates.filter((token) => !source.includes(token.toLowerCase()))));
}
