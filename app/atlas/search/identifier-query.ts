/**
 * SEARCH-54: identifier-shaped queries — hex addresses, hashes, UUID fragments.
 *
 * A hex string has no meaning to embed: embeddings of identifier-dense text are all
 * cosine-close to each other, so the semantic rung "confidently" retrieves OTHER
 * addresses (external review, batch 2). Queries made entirely of identifier-shaped
 * tokens therefore skip the dense rung; keyword matching handles identifiers exactly.
 *
 * Document numbers (dotted tokens, `a.1.2`) are explicitly NOT identifiers — they
 * carry their own machinery (whole-token indexing, prefix navigation, UUID jumps)
 * and must keep today's behaviour.
 */

/** `0x`-prefixed hex of any useful length (addresses, storage slots, tx hashes). */
const HEX_0X = /^0x[0-9a-f]{4,}$/i;
/** Bare hex ≥ 8 chars with at least one letter — digits-only tokens are numbers, not ids. */
const BARE_HEX = /^[0-9a-f]{8,}$/i;

export function isIdentifierToken(token: string): boolean {
  if (token.includes('.')) return false; // document numbers are never identifiers
  if (HEX_0X.test(token)) return true;
  return BARE_HEX.test(token) && /[a-f]/i.test(token);
}

/** True when the query's content tokens are all identifier-shaped (and there is one). */
export function isIdentifierQuery(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every(isIdentifierToken);
}
