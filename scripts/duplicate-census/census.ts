/**
 * Duplicate census over the flattened Atlas corpus (SEARCH-16).
 *
 * Three operational definitions of "duplicate", from strictest to loosest:
 *
 * 1. **Identical body** — the NFC-normalised, case- and whitespace-folded content is
 *    byte-equal. Empty bodies are excluded (22 structural documents have no content at
 *    all; "everything empty is one family" is not a useful statement).
 * 2. **Near-duplicate** — Jaccard similarity ≥ `threshold` (default 0.9) over word
 *    3-shingles, computed **exactly**: the corpus is small enough that MinHash's
 *    approximation (the agenda's suggested estimator for this definition) is not needed.
 *    Only bodies with at least `minWords` words participate — shorter texts make shingle
 *    similarity degenerate, and they are already covered by definition 1.
 * 3. **Same name** — the normalised document name is shared. Reported in two flavours:
 *    *template families* (every member also shares its parent's name — the nine "Maximum
 *    Exposure" documents all sit under "Off-chain Operational Parameters") and *mixed-
 *    parent groups* (the same name under structurally different parents).
 *
 * 4. **Embedding cosine** — cosine similarity ≥ `EMBEDDING_COSINE_THRESHOLD` between the
 *    documents' body embeddings (SEARCH-18's vectors; deferred until they existed, added
 *    2026-08-31). Catches semantically-identical-but-reworded documents that fall below
 *    the shingling floor (the F03 near-twins). Same `minWords` floor as definition 2 —
 *    tiny bodies embed degenerately. Families are single-link components, as in 2.
 */

export interface CensusDocument {
  doc_no: string;
  name: string;
  type: string;
  /** Ancestor names, outermost first (FlatAtlasDocument.breadcrumb). */
  breadcrumb: string[];
  content: string;
}

export interface Family {
  /** Sorted member document numbers. */
  docNos: string[];
  /** Shared document name when every member has the same normalised name. */
  name?: string;
  /** Representative body length in characters (definitions 1 and 2). */
  bodyChars?: number;
}

export interface FamilySetSummary {
  families: number;
  documents: number;
  /** family size -> number of families of that size */
  sizeDistribution: Record<number, number>;
  /** document type -> number of documents that belong to some family */
  documentsByType: Record<string, number>;
}

export interface Census {
  documents: number;
  emptyBodies: number;
  identicalBody: { summary: FamilySetSummary; families: Family[] };
  /** Identical-body families whose body is at least 200 characters — the "substantial
   * text" subset where collapsing is a user-visible improvement rather than noise. */
  identicalBodySubstantial: { summary: FamilySetSummary; families: Family[] };
  nearDuplicate: {
    threshold: number;
    minWords: number;
    shingleSize: number;
    summary: FamilySetSummary;
    families: Family[];
  };
  sameNameSameParent: { summary: FamilySetSummary; families: Family[] };
  sameNameMixedParent: { summary: FamilySetSummary; families: Family[] };
  /** Definition 4; present only when the census was built with vectors. */
  embeddingCosine?: {
    model: string;
    threshold: number;
    minWords: number;
    /** Pair counts at sweep thresholds, for threshold sensitivity. */
    pairCounts: Record<string, number>;
    summary: FamilySetSummary;
    families: Family[];
  };
}

export const SUBSTANTIAL_BODY_CHARS = 200;
export const NEAR_DUPLICATE_THRESHOLD = 0.9;
export const NEAR_DUPLICATE_MIN_WORDS = 15;
export const SHINGLE_SIZE = 3;
export const EMBEDDING_COSINE_THRESHOLD = 0.98;
export const COSINE_SWEEP_THRESHOLDS = [0.95, 0.98, 0.99] as const;

/** One canonical text form for equality: NFC, case-folded, whitespace-collapsed. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Word 3-shingles of a normalised body; the unit of the Jaccard comparison. */
export function wordShingles(normalizedText: string, size: number = SHINGLE_SIZE): Set<string> {
  const words = normalizedText.split(' ').filter(Boolean);
  const shingles = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Deterministic family ordering: by size descending, then by first member. */
function sortFamilies(families: Family[]): Family[] {
  return [...families].sort(
    (left, right) => right.docNos.length - left.docNos.length || left.docNos[0].localeCompare(right.docNos[0]),
  );
}

function summarize(families: Family[], docs: CensusDocument[]): FamilySetSummary {
  const memberDocNos = new Set(families.flatMap((family) => family.docNos));
  const documentsByType: Record<string, number> = {};
  for (const doc of docs) {
    if (!memberDocNos.has(doc.doc_no)) continue;
    documentsByType[doc.type] = (documentsByType[doc.type] ?? 0) + 1;
  }
  const sizeDistribution: Record<number, number> = {};
  for (const family of families) {
    sizeDistribution[family.docNos.length] = (sizeDistribution[family.docNos.length] ?? 0) + 1;
  }
  return { families: families.length, documents: memberDocNos.size, sizeDistribution, documentsByType };
}

/** Groups documents by a key; keys mapping to fewer than two documents are dropped. */
function familiesByKey(
  docs: CensusDocument[],
  keyOf: (doc: CensusDocument) => string | null,
  decorate?: (members: CensusDocument[]) => Partial<Family>,
): Family[] {
  const groups = new Map<string, CensusDocument[]>();
  for (const doc of docs) {
    const key = keyOf(doc);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(doc);
    else groups.set(key, [doc]);
  }
  const families: Family[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    families.push({
      docNos: members.map((doc) => doc.doc_no).sort(),
      ...(decorate ? decorate(members) : {}),
    });
  }
  return sortFamilies(families);
}

export function identicalBodyFamilies(docs: CensusDocument[]): Family[] {
  return familiesByKey(
    docs,
    (doc) => normalizeText(doc.content) || null,
    (members) => {
      const names = new Set(members.map((doc) => normalizeText(doc.name)));
      return {
        bodyChars: normalizeText(members[0].content).length,
        ...(names.size === 1 ? { name: members[0].name } : {}),
      };
    },
  );
}

/**
 * Exact all-pairs Jaccard ≥ threshold over word shingles, with two prunes that cannot
 * change the result: candidate pairs must share at least one shingle (inverted index),
 * and |A| / |B| ≥ threshold (a Jaccard ≥ t pair cannot differ in size by more than t).
 * `documentFrequencyCap` can skip candidate generation for shingles occurring in more
 * than that many distinct bodies; it is a lossy prune for pathological corpora and is
 * therefore **off by default** — the full run costs 0.3 s on the live corpus, and a
 * capped run (500) was measured to produce the identical result there (2026-08-31).
 *
 * Identical bodies are collapsed to one representative first, then re-expanded, so the
 * near-duplicate families are a superset of the identical-body families for bodies long
 * enough to participate. Families are the connected components of the ≥-threshold pair
 * graph (single-link; the census document records that choice).
 */
export function nearDuplicateFamilies(
  docs: CensusDocument[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
  minWords: number = NEAR_DUPLICATE_MIN_WORDS,
  documentFrequencyCap = Number.POSITIVE_INFINITY,
): Family[] {
  const byBody = new Map<string, CensusDocument[]>();
  for (const doc of docs) {
    const body = normalizeText(doc.content);
    if (!body || body.split(' ').length < minWords) continue;
    const group = byBody.get(body);
    if (group) group.push(doc);
    else byBody.set(body, [doc]);
  }

  const bodies = [...byBody.keys()];
  const shingleSets = bodies.map((body) => wordShingles(body));

  const postings = new Map<string, number[]>();
  for (const [index, shingles] of shingleSets.entries()) {
    for (const shingle of shingles) {
      const posting = postings.get(shingle);
      if (posting) posting.push(index);
      else postings.set(shingle, [index]);
    }
  }

  const parent = bodies.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    parent[find(left)] = find(right);
  };

  const compared = new Set<number>();
  for (const posting of postings.values()) {
    if (posting.length < 2) continue;
    if (posting.length > documentFrequencyCap) continue; // lossy escape hatch, off by default
    for (let i = 0; i < posting.length; i += 1) {
      for (let j = i + 1; j < posting.length; j += 1) {
        const [a, b] = [posting[i], posting[j]];
        const pairKey = a * bodies.length + b;
        if (compared.has(pairKey)) continue;
        compared.add(pairKey);
        const [sizeA, sizeB] = [shingleSets[a].size, shingleSets[b].size];
        if (Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB) < threshold) continue;
        if (jaccard(shingleSets[a], shingleSets[b]) >= threshold) union(a, b);
      }
    }
  }

  const components = new Map<number, number[]>();
  for (let index = 0; index < bodies.length; index += 1) {
    const root = find(index);
    const component = components.get(root);
    if (component) component.push(index);
    else components.set(root, [index]);
  }

  const families: Family[] = [];
  for (const memberIndexes of components.values()) {
    const members = memberIndexes.flatMap((index) => byBody.get(bodies[index])!);
    if (members.length < 2) continue;
    const names = new Set(members.map((doc) => normalizeText(doc.name)));
    families.push({
      docNos: members.map((doc) => doc.doc_no).sort(),
      bodyChars: bodies[memberIndexes[0]].length,
      ...(names.size === 1 ? { name: members[0].name } : {}),
    });
  }
  return sortFamilies(families);
}

/**
 * Definition 4: single-link components of the pairwise cosine ≥ `threshold` graph over
 * body embeddings (normalised vectors; cosine = dot product). One exact blocked pass over
 * all pairs — ~65M dot products at this corpus size, seconds in practice — counting pairs
 * at every sweep threshold while unioning at the main one.
 *
 * `vectors[i]` must correspond to `docs[i]`. Documents whose body has fewer than
 * `minWords` words are excluded, like definition 2 and for the same reason.
 */
export function cosineFamilies(
  docs: CensusDocument[],
  vectors: Float32Array[],
  threshold: number = EMBEDDING_COSINE_THRESHOLD,
  minWords: number = NEAR_DUPLICATE_MIN_WORDS,
): { families: Family[]; pairCounts: Record<string, number> } {
  if (vectors.length !== docs.length) throw new Error('vectors must align with docs');
  const eligible: number[] = [];
  for (let index = 0; index < docs.length; index += 1) {
    const body = normalizeText(docs[index].content);
    if (body && body.split(' ').length >= minWords) eligible.push(index);
  }

  const parent = eligible.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };

  const sweep = [...COSINE_SWEEP_THRESHOLDS].sort((a, b) => a - b);
  const pairCounts: Record<string, number> = Object.fromEntries(sweep.map((t) => [t.toFixed(2), 0]));
  const dims = vectors[0]?.length ?? 0;
  for (let i = 0; i < eligible.length; i += 1) {
    const a = vectors[eligible[i]];
    for (let j = i + 1; j < eligible.length; j += 1) {
      const b = vectors[eligible[j]];
      let dot = 0;
      for (let d = 0; d < dims; d += 1) dot += a[d] * b[d];
      for (const t of sweep) {
        if (dot >= t) pairCounts[t.toFixed(2)] += 1;
        else break;
      }
      if (dot >= threshold) parent[find(i)] = find(j);
    }
  }

  const components = new Map<number, number[]>();
  for (let index = 0; index < eligible.length; index += 1) {
    const root = find(index);
    const component = components.get(root);
    if (component) component.push(eligible[index]);
    else components.set(root, [eligible[index]]);
  }

  const families: Family[] = [];
  for (const memberIndexes of components.values()) {
    if (memberIndexes.length < 2) continue;
    const members = memberIndexes.map((index) => docs[index]);
    const names = new Set(members.map((doc) => normalizeText(doc.name)));
    families.push({
      docNos: members.map((doc) => doc.doc_no).sort(),
      bodyChars: normalizeText(members[0].content).length,
      ...(names.size === 1 ? { name: members[0].name } : {}),
    });
  }
  return { families: sortFamilies(families), pairCounts };
}

function parentName(doc: CensusDocument): string {
  return normalizeText(doc.breadcrumb[doc.breadcrumb.length - 1] ?? '');
}

/** Same-name groups where every member also shares its parent's name (template shape). */
export function sameNameSameParentFamilies(docs: CensusDocument[]): Family[] {
  return familiesByKey(
    docs,
    (doc) => {
      const name = normalizeText(doc.name);
      return name ? `${name}\u0000${parentName(doc)}` : null;
    },
    (members) => ({ name: members[0].name }),
  );
}

/** Same-name groups spanning at least two distinct parent names. */
export function sameNameMixedParentFamilies(docs: CensusDocument[]): Family[] {
  const byName = familiesByKey(
    docs,
    (doc) => normalizeText(doc.name) || null,
    (members) => ({ name: members[0].name }),
  );
  const docByNo = new Map(docs.map((doc) => [doc.doc_no, doc]));
  return byName.filter((family) => new Set(family.docNos.map((docNo) => parentName(docByNo.get(docNo)!))).size > 1);
}

export function buildCensus(docs: CensusDocument[], cosine?: { model: string; vectors: Float32Array[] }): Census {
  const identical = identicalBodyFamilies(docs);
  const substantial = identical.filter((family) => (family.bodyChars ?? 0) >= SUBSTANTIAL_BODY_CHARS);
  const near = nearDuplicateFamilies(docs);
  const templateFamilies = sameNameSameParentFamilies(docs);
  const mixedFamilies = sameNameMixedParentFamilies(docs);
  const embeddingCosine = cosine
    ? (() => {
        const { families, pairCounts } = cosineFamilies(docs, cosine.vectors);
        return {
          model: cosine.model,
          threshold: EMBEDDING_COSINE_THRESHOLD,
          minWords: NEAR_DUPLICATE_MIN_WORDS,
          pairCounts,
          summary: summarize(families, docs),
          families,
        };
      })()
    : undefined;
  return {
    ...(embeddingCosine ? { embeddingCosine } : {}),
    documents: docs.length,
    emptyBodies: docs.filter((doc) => normalizeText(doc.content) === '').length,
    identicalBody: { summary: summarize(identical, docs), families: identical },
    identicalBodySubstantial: { summary: summarize(substantial, docs), families: substantial },
    nearDuplicate: {
      threshold: NEAR_DUPLICATE_THRESHOLD,
      minWords: NEAR_DUPLICATE_MIN_WORDS,
      shingleSize: SHINGLE_SIZE,
      summary: summarize(near, docs),
      families: near,
    },
    sameNameSameParent: { summary: summarize(templateFamilies, docs), families: templateFamilies },
    sameNameMixedParent: { summary: summarize(mixedFamilies, docs), families: mixedFamilies },
  };
}

export interface FamilyCrossCheck {
  queryId: string;
  judged: string[];
  /** Census family (by any definition given) containing at least one judged member. */
  matchedBy: string[];
  missingFromJudged: string[];
  judgedNotInCensusFamily: string[];
}

/**
 * Compares a judged duplicate family (SEARCH-15's F-queries) against the census: which
 * census definitions produce a family containing its members, which corpus documents the
 * judgment omitted, and which judged members the census does not consider duplicates.
 */
export function crossCheckFamily(queryId: string, judgedDocNos: string[], census: Census): FamilyCrossCheck {
  const judged = new Set(judgedDocNos);
  const matchedBy: string[] = [];
  const censusMembers = new Set<string>();
  const definitions: [string, Family[]][] = [
    ['identical-body', census.identicalBody.families],
    ['near-duplicate', census.nearDuplicate.families],
    ['same-name-same-parent', census.sameNameSameParent.families],
    ['same-name-mixed-parent', census.sameNameMixedParent.families],
    ...(census.embeddingCosine ? [['embedding-cosine', census.embeddingCosine.families] as [string, Family[]]] : []),
  ];
  for (const [label, families] of definitions) {
    const overlapping = families.filter((family) => family.docNos.some((docNo) => judged.has(docNo)));
    if (overlapping.length === 0) continue;
    matchedBy.push(label);
    for (const family of overlapping) for (const docNo of family.docNos) censusMembers.add(docNo);
  }
  return {
    queryId,
    judged: [...judged].sort(),
    matchedBy,
    missingFromJudged: [...censusMembers].filter((docNo) => !judged.has(docNo)).sort(),
    judgedNotInCensusFamily: judgedDocNos.filter((docNo) => !censusMembers.has(docNo)).sort(),
  };
}
