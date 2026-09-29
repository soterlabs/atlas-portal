/**
 * SEARCH-40: pure document fragmenter for the ranking-methods library.
 *
 * Splits a document's text into overlapping fragments at markdown heading and
 * paragraph boundaries, so a long rule's individual clauses can be embedded and
 * matched on their own (SEARCH-41's experiment). Defaults follow zvec-grep's
 * measured parameters (3,600 chars with 540 overlap).
 *
 * Pure: plain text in, plain fragments out. No I/O, no engine imports. Nothing in
 * the shipped search path uses this module until a measured decision says so.
 */

export interface FragmentOptions {
  /** Maximum characters per fragment. */
  chunkChars: number;
  /** Characters of trailing context carried into the next fragment. */
  overlapChars: number;
}

export const DEFAULT_FRAGMENT_OPTIONS: FragmentOptions = { chunkChars: 3600, overlapChars: 540 };

export interface DocumentFragment {
  /** 0-based position of the fragment within the document. */
  index: number;
  /** The fragment text (may begin with overlap carried from the previous fragment). */
  text: string;
  /** The markdown heading in effect where this fragment starts, if any. */
  heading?: string;
}

interface Block {
  text: string;
  heading?: string;
}

const HEADING_PATTERN = /^#{1,6}\s+\S/;

/** Split text into heading/paragraph blocks; a heading line starts its own block. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | undefined;
  for (const raw of text.split(/\n{2,}/)) {
    const paragraph = raw.trim();
    if (paragraph.length === 0) continue;
    // A paragraph may open with a heading line; the heading scopes what follows.
    const [firstLine] = paragraph.split('\n', 1);
    if (HEADING_PATTERN.test(firstLine)) heading = firstLine.replace(/^#{1,6}\s+/, '').trim();
    blocks.push({ text: paragraph, heading });
  }
  return blocks;
}

/** Hard-split one oversized block into windows stepping by (chunkChars − overlapChars). */
function splitOversized(block: Block, options: FragmentOptions): Block[] {
  const step = Math.max(1, options.chunkChars - options.overlapChars);
  const pieces: Block[] = [];
  for (let start = 0; start < block.text.length; start += step) {
    pieces.push({ text: block.text.slice(start, start + options.chunkChars), heading: block.heading });
    if (start + options.chunkChars >= block.text.length) break;
  }
  return pieces;
}

/**
 * Fragment a document. Invariants (pinned by tests):
 *  - every non-whitespace character of the input appears in some fragment;
 *  - no fragment's own content exceeds `chunkChars` (overlap prefix excluded);
 *  - fragments are in document order with contiguous indexes from 0.
 */
export function fragmentDocument(
  text: string,
  options: FragmentOptions = DEFAULT_FRAGMENT_OPTIONS,
): DocumentFragment[] {
  if (options.chunkChars < 1) throw new Error('chunkChars must be positive');
  if (options.overlapChars < 0 || options.overlapChars >= options.chunkChars) {
    throw new Error('overlapChars must be in [0, chunkChars)');
  }

  const blocks = splitBlocks(text).flatMap((block) =>
    block.text.length > options.chunkChars ? splitOversized(block, options) : [block],
  );
  if (blocks.length === 0) return [];

  const fragments: DocumentFragment[] = [];
  let content = '';
  let heading: string | undefined;
  let overlapPrefix = '';

  const flush = (): void => {
    if (content.length === 0) return;
    fragments.push({ index: fragments.length, text: overlapPrefix + content, heading });
    overlapPrefix = content.slice(Math.max(0, content.length - overlapChars(content)));
    content = '';
  };
  const overlapChars = (chunk: string): number => Math.min(options.overlapChars, chunk.length);

  for (const block of blocks) {
    const joined = content.length === 0 ? block.text : `${content}\n\n${block.text}`;
    if (content.length > 0 && joined.length > options.chunkChars) flush();
    if (content.length === 0) heading = block.heading;
    content = content.length === 0 ? block.text : `${content}\n\n${block.text}`;
  }
  flush();
  return fragments;
}
