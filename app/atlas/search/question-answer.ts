/**
 * SEARCH-84: simple question answering — template-or-silence (the adopted
 * spec: "something simple and safe that will work only for questions that can
 * be easily resolved, not an advanced QA system").
 *
 * A closed template list is recognized: "what is X" / "who is X" (definition)
 * and "how many X" (count). Anything else — and any failed resolution —
 * produces null, and the page is indistinguishable from a plain search. The
 * raw question always ALSO runs as a normal search, byte-identical to typing
 * it today, so no existing ranking changes; the answer is purely additive.
 * Deterministic; no model calls; every answer names its provenance.
 *
 * Definitions come from the recorded "defines" facts and need the structural
 * data loaded; counts are read live from the document tree (a directory-shaped
 * section whose name matches the counted phrase) and need nothing else.
 */
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import type { AtlasGraph } from './graph-artifact';
import { resolveQueryEntities } from './ranking/graph-route';
import { entityDisplayName } from './related-documents';
import { stemTerm } from './search-index';

export type ParsedQuestion = { kind: 'definition'; subject: string } | { kind: 'count'; subject: string };

/** Words that end the counted noun phrase ("how many X does/are/is …"). */
const PHRASE_END = new Set([
  'does',
  'do',
  'did',
  'is',
  'are',
  'was',
  'were',
  'can',
  'could',
  'should',
  'would',
  'will',
  'has',
  'have',
  'exist',
  'there',
]);
const LEADING_FILLER = new Set(['the', 'a', 'an']);
/** Longest subject the templates accept — anything longer is not "easily resolved". */
const MAX_SUBJECT_WORDS = 6;

/** The v1 template match for a query, or null — null means "not a question we answer". */
export function parseQuestion(query: string): ParsedQuestion | null {
  const words = foldText(query)
    .replace(/[?.!]+\s*$/u, '')
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
  if (words.length < 3) return null;

  const subjectOf = (rest: string[]): string | null => {
    while (rest.length > 0 && LEADING_FILLER.has(rest[0])) rest = rest.slice(1);
    if (rest.length === 0 || rest.length > MAX_SUBJECT_WORDS) return null;
    return rest.join(' ');
  };

  if ((words[0] === 'what' || words[0] === 'who') && (words[1] === 'is' || words[1] === 'are')) {
    const subject = subjectOf(words.slice(2));
    return subject ? { kind: 'definition', subject } : null;
  }
  if (words[0] === 'how' && words[1] === 'many') {
    const rest = words.slice(2);
    const end = rest.findIndex((word) => PHRASE_END.has(word));
    const subject = subjectOf(rest.slice(0, end === -1 ? rest.length : end));
    return subject ? { kind: 'count', subject } : null;
  }
  return null;
}

export interface QuestionAnswer {
  kind: ParsedQuestion['kind'];
  /** The section the answer points at — the row navigates here. */
  docNo: string;
  sectionName: string;
  /** The stated answer, a full sentence naming its provenance. */
  text: string;
  /** Extractive first sentence of the defining section (definitions only). */
  preview?: string;
}

const contentStems = (text: string): string[] =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !LEADING_FILLER.has(token) && token !== 'of')
    .map(stemTerm);

/** First sentence of a section body, capped, for the definition preview. */
function firstSentence(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const stop = trimmed.search(/[.!?](\s|$)/u);
  const sentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return sentence.length > 220 ? `${sentence.slice(0, 219).trimEnd()}…` : sentence;
}

/**
 * The answer for a parsed question, or null (silence). Definitions require the
 * structural data (`graph`); counts only read the document tree.
 */
export function answerQuestion(
  question: ParsedQuestion,
  documents: readonly FlatAtlasDocument[],
  graph: AtlasGraph | null,
): QuestionAnswer | null {
  if (question.kind === 'definition') return answerDefinition(question.subject, documents, graph);
  return answerCount(question.subject, documents);
}

function answerDefinition(
  subject: string,
  documents: readonly FlatAtlasDocument[],
  graph: AtlasGraph | null,
): QuestionAnswer | null {
  if (!graph) return null;
  const subjectStems = new Set(contentStems(subject));
  if (subjectStems.size === 0) return null;
  for (const entity of resolveQueryEntities(subject, graph)) {
    // The resolved entity must account for the WHOLE subject — a partial match
    // ("slippery slope" out of "slippery slope of governance") risks answering
    // a different question, so it stays silent instead.
    const surface = new Set(contentStems(entity.surface));
    if (![...subjectStems].every((stem) => surface.has(stem))) continue;
    const aspect = (graph.aspectsOf.get(entity.id) ?? []).find((entry) => entry.canonical === 'defines');
    if (!aspect) continue;
    const section = documents.find((document) => document.doc_no === aspect.section);
    if (!section) continue;
    const name = entityDisplayName(entity.id, graph);
    return {
      kind: 'definition',
      docNo: section.doc_no,
      sectionName: section.name,
      text: `${name} is defined in “${section.name}”.`,
      preview: firstSentence(section.content),
    };
  }
  return null;
}

function answerCount(subject: string, documents: readonly FlatAtlasDocument[]): QuestionAnswer | null {
  const subjectStems = contentStems(subject);
  if (subjectStems.length === 0) return null;

  // Direct children per document id — the tree is the registry being counted.
  const childCounts = new Map<number, number>();
  for (const document of documents) {
    if (document.parentId !== null) childCounts.set(document.parentId, (childCounts.get(document.parentId) ?? 0) + 1);
  }

  let best: { document: FlatAtlasDocument; extraWords: number; children: number } | null = null;
  documents.forEach((document, id) => {
    const children = childCounts.get(id) ?? 0;
    if (children === 0) return;
    const nameStems = contentStems(document.name);
    const nameSet = new Set(nameStems);
    if (!subjectStems.every((stem) => nameSet.has(stem))) return;
    const extraWords = nameStems.length - subjectStems.length;
    if (
      !best ||
      extraWords < best.extraWords ||
      (extraWords === best.extraWords && children > best.children) ||
      (extraWords === best.extraWords && children === best.children && document.doc_no < best.document.doc_no)
    ) {
      best = { document, extraWords, children };
    }
  });
  if (!best) return null;
  const { document, children } = best as { document: FlatAtlasDocument; extraWords: number; children: number };
  return {
    kind: 'count',
    docNo: document.doc_no,
    sectionName: document.name,
    text: `${children} document${children === 1 ? '' : 's'} filed directly under “${document.name}” (${document.doc_no}).`,
  };
}
