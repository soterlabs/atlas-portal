/**
 * Mechanical verification for answers (SEARCH-25).
 *
 * The ticket's bars — citation faithfulness 100%, qualifier retention 100% — are
 * enforced here, in code, not trusted from the model. The original design leaned on the
 * Anthropic citations API's spans; an OpenAI key is configured, so the same property is
 * provided locally: the model must return, per claim, a **verbatim quote** and the
 * document number it came from, and this module checks that the quote really is a
 * contiguous passage of that document. Whitespace is normalised on both sides (line
 * wrapping and markdown reflow must not fail an honest quote); every other character
 * must match exactly, so a paraphrase, an elision, or a changed number all fail.
 */

/** Whitespace-normalised form used on both sides of the containment check. */
export function normalizeForQuote(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

const MIN_QUOTE_LENGTH = 15;

/**
 * True when `quote` is a verbatim contiguous passage of `documentText`.
 * Very short quotes are rejected outright: a three-word "quote" can be assembled from
 * almost any document and supports nothing.
 */
export function quoteIsVerbatim(quote: string, documentText: string): boolean {
  const needle = normalizeForQuote(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return false;
  return normalizeForQuote(documentText).includes(needle);
}

/**
 * Qualifier retention: every required qualifier phrase must appear in the answer —
 * verbatim after normalisation, or unambiguously via its quote (a claim that quotes the
 * sentence containing the qualifier retains it even if the claim's own wording is
 * shorter). The eval counts a question as retained only when ALL its qualifiers pass.
 */
export function qualifierRetained(qualifier: string, claimTexts: string[], claimQuotes: string[]): boolean {
  const needle = normalizeForQuote(qualifier).toLowerCase();
  if (!needle) return true;
  return [...claimTexts, ...claimQuotes].some((text) => normalizeForQuote(text).toLowerCase().includes(needle));
}

export interface ClaimForVerification {
  text: string;
  quote: string;
  docNo: string;
}

export interface ClaimVerification {
  claim: ClaimForVerification;
  /** False when the cited document is not in the provided context at all. */
  documentKnown: boolean;
  /** False when the quote is not a verbatim passage of the cited document. */
  quoteVerbatim: boolean;
}

/** Verifies every claim against the context documents (doc_no → full text). */
export function verifyClaims(
  claims: ClaimForVerification[],
  documentTextByDocNo: Map<string, string>,
): ClaimVerification[] {
  return claims.map((claim) => {
    const text = documentTextByDocNo.get(claim.docNo);
    return {
      claim,
      documentKnown: text !== undefined,
      quoteVerbatim: text !== undefined && quoteIsVerbatim(claim.quote, text),
    };
  });
}

/** An answer is faithful only when every single claim verifies. */
export function allFaithful(verifications: ClaimVerification[]): boolean {
  return verifications.length > 0 && verifications.every((entry) => entry.documentKnown && entry.quoteVerbatim);
}
