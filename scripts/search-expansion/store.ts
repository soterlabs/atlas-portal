/**
 * The expansion store (SEARCH-17): one generated entry per Atlas document, keyed by the
 * document's UUID (falling back to `doc_no` for the rare documents without one), each
 * carrying the hash of the source text it was generated from. Regeneration is
 * incremental: a document whose hash still matches is never re-sent to the model.
 *
 * The store is a committed artifact (`data/search/expansions.json`), so index builds are
 * reproducible and the weekly regeneration run produces a reviewable diff.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { FlatAtlasDocument } from '../../app/atlas/search/flatten-documents';

export const STORE_PATH = 'data/search/expansions.json';

export interface ExpansionEntry {
  /** Hash of the source text this entry was generated from (see `documentHash`). */
  hash: string;
  /** Plain-language paraphrase in the reader's vocabulary. */
  paraphrase: string;
  /** Questions a governance participant would type to find this document. */
  questions: string[];
  /** Model that generated the entry, for provenance. */
  model: string;
}

export interface ExpansionStore {
  version: 1;
  entries: Record<string, ExpansionEntry>;
}

/** Stable identity for a document: UUID when present, `doc_no` otherwise. */
export function documentKey(doc: FlatAtlasDocument): string {
  const uuid = (doc.source as { uuid?: string | null }).uuid;
  return uuid ?? doc.doc_no;
}

/**
 * Hash of everything the expansion is generated from. Breadcrumb is included because the
 * prompt shows it; a moved document is re-generated even when its body is unchanged.
 */
export function documentHash(doc: FlatAtlasDocument): string {
  return createHash('sha256')
    .update([doc.name, doc.content, doc.extras, doc.breadcrumb.join(' › ')].join('\u0000'))
    .digest('hex');
}

export function loadStore(path: string = STORE_PATH): ExpansionStore {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExpansionStore;
  if (parsed.version !== 1 || typeof parsed.entries !== 'object') {
    throw new Error(`${path} is not a version-1 expansion store`);
  }
  return parsed;
}

export function saveStore(store: ExpansionStore, path: string = STORE_PATH): void {
  const ordered: ExpansionStore = {
    version: 1,
    // Deterministic key order keeps the committed diff minimal.
    entries: Object.fromEntries(Object.entries(store.entries).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Documents with no entry, or whose source text changed since their entry was generated. */
export function staleDocuments(docs: FlatAtlasDocument[], store: ExpansionStore): FlatAtlasDocument[] {
  return docs.filter((doc) => store.entries[documentKey(doc)]?.hash !== documentHash(doc));
}

/**
 * The text the index consumes for a document: paraphrase and questions, newline-joined;
 * empty when the store has no current entry (the field then simply contributes nothing).
 */
export function expansionText(doc: FlatAtlasDocument, store: ExpansionStore): string {
  const entry = store.entries[documentKey(doc)];
  if (!entry || entry.hash !== documentHash(doc)) return '';
  return [entry.paraphrase, ...entry.questions].join('\n');
}

/** The expansion map handed to `flattenAtlasDocuments` by the index build. */
export function expansionMap(docs: FlatAtlasDocument[], store: ExpansionStore): Record<string, string> {
  const map: Record<string, string> = {};
  for (const doc of docs) {
    const text = expansionText(doc, store);
    if (text) map[documentKey(doc)] = text;
  }
  return map;
}
