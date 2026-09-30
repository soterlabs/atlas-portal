'use client';

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input, Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/react';
import { LoaderCircle, Maximize2, Minimize2, Search, Sparkles } from 'lucide-react';
import { dispatchExpandScopeEvent } from '@/app/atlas/custom-events';
import type { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { typeColorMap } from '@/app/server/atlas/formatters/type-color-map';
import type { SearchAnswerResponse } from '@/app/shared/search-answer';
import { MAX_QUERY_REWRITE_LENGTH, MAX_QUERY_REWRITE_SCOPES } from '@/app/shared/search-query-rewrite';
import { AnswerClientError, fetchAtlasAnswer } from './answer-client';
import { distinguishingSegments } from './distinguish';
import { buildEntityLexicon, detectEntityQuery } from './entity-lexicon';
import { PARTIAL_COVERAGE_FLOOR, coverageOf, isExactMatch, queryStems } from './exactness';
import { findMatchingExtraField } from './extra-fields';
import type { FlatAtlasDocument } from './flatten-documents';
import { foldText } from './fold';
import { type AtlasGraph, tryLoadGraph } from './graph-artifact';
import { buildSnippet, splitHighlight } from './highlight';
import { detectGraphInterpretations } from './interpretation-chips';
import { EVIDENCE_LABEL, classifyHit, originNote } from './match-evidence';
import { type PanelRect, type ResizeEdge, centeredPanel, maximizedPanel, resizePanel } from './modal-resize';
import { rewriteAtlasQuery } from './query-rewrite-client';
import { type ParsedQuery, parseQuerySyntax } from './query-syntax';
import { answerQuestion, parseQuestion } from './question-answer';
import { describeReason, relatedDocuments } from './related-documents';
import { RELATED_STRENGTH_FLOOR, relatedResults } from './related-results';
import { scopeChips } from './scope-chips';
import { isStopWordOnlyQuery, tokenizeQueryUnstemmed } from './search-index';
import type { AtlasSearchHit } from './search-index';
import type { SegmentGroupSummary } from './segmentation';
import { buildTitleKeywordIndex, suggestTitleKeywords, titleTokens } from './title-keywords';
import { buildTreeContext } from './tree-context';
import { type UpgradedAtlasSearchResults, useAtlasSearch } from './use-atlas-search';
import { useRecentSearches } from './use-recent-searches';

/** Input debounce, spec §7. */
const DEBOUNCE_MS = 120;

/**
 * Shortest query that is searched (SEARCH-03). One- and two-character queries are not
 * meaningful Atlas queries (`A` alone prefix-matches every document number) and a
 * single common character costs 33–39 ms against the 10 ms budget, because prefix +
 * fuzzy expand it onto every term in the index. Below this length the modal shows the
 * hint/recents state instead of calling the engine.
 */
export const MIN_QUERY_LENGTH = 3;

/**
 * Document types are a governance concept and new ones get added to the Atlas over time.
 * `typeColorMap` is keyed by the types known today, so an unmapped type would otherwise
 * interpolate the string "undefined" into a className. Fall back to a neutral chip.
 */
const FALLBACK_TYPE_COLOR = 'bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-slate-200';

// SEARCH-66: a stable empty list, so the row context's identity survives renders
// where no rows are peeked or expanded.
const NO_IDS: number[] = [];

// SEARCH-58: the result list partitioned into match-category sections — a pure
// partition of the composed ranking at its tier boundaries, never a reorder. Each
// section shows its first SECTION_PAGE[category] top-level rows behind a "Show
// all" reveal — SEARCH-68 (the agreed numbers): 10 exact, 5 for the rest.
// SEARCH-74 follow-up: 5 per category by default, for navigation.
const SECTION_PAGE: Record<SectionCategory, number> = {
  exact: 5,
  related: 5,
  similar: 5,
  partial: 5,
};
// SEARCH-74 (from testing): Exact → Similar → Partial → Related —
// the recorded-connection rows close the list.
const SECTION_ORDER = ['exact', 'similar', 'partial', 'related'] as const;
type SectionCategory = (typeof SECTION_ORDER)[number];
const SECTION_LABEL: Record<SectionCategory, string> = {
  exact: 'Exact matches',
  related: 'Related results',
  similar: 'Similar results',
  partial: 'Partial matches',
};
// SEARCH-70 (the adopted policy): "Exact matches" means the query words occur
// near each other, in order, in the document's OWN text — every approximation
// (word-scatter, generated-text-supplied words, one-word matches, abbreviation
// expansions) presents as a Partial match. The engine's ranking is untouched;
// this only decides which section a row renders under.
function displayCategoryOf(hit: AtlasSearchHit, doc: FlatAtlasDocument, stems: string[]): SectionCategory {
  if (hit.provenance === 'rung') return 'similar';
  if (hit.provenance === 'relaxed' || hit.provenance === 'expanded') return 'partial';
  return stems.length > 0 && isExactMatch(stems, doc) ? 'exact' : 'partial';
}

// SEARCH-72: deterministic diversity interleave for the Exact section — one
// row per key per wave, so the visible page spans distinct places in the Atlas
// while nothing is removed or hidden.
function diversityInterleave(rows: ResultRowEntry[], keyOf: (doc: FlatAtlasDocument) => string): ResultRowEntry[] {
  const byKey = new Map<string, ResultRowEntry[]>();
  const keys: string[] = [];
  for (const row of rows) {
    const key = keyOf(row.doc);
    const list = byKey.get(key);
    if (list) list.push(row);
    else {
      byKey.set(key, [row]);
      keys.push(key);
    }
  }
  const out: ResultRowEntry[] = [];
  for (let wave = 0; out.length < rows.length; wave++) {
    for (const key of keys) {
      const list = byKey.get(key)!;
      if (wave < list.length) out.push(list[wave]);
    }
  }
  return out;
}

function typeColor(type: string): string {
  return typeColorMap[type as keyof typeof typeColorMap] ?? FALLBACK_TYPE_COLOR;
}

interface SearchModalProps {
  scopeTrees: ExportAtlasTreeDocument[];
  isOpen: boolean;
  onClose: () => void;
  queryRewriteEnabled?: boolean;
  answersEnabled?: boolean;
}

interface AppliedRewrite {
  originalQuery: string;
  originalTypes: string[];
  originalScopes: string[];
  searchQuery: string;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeoutId);
  }, [value, delayMs]);

  return debounced;
}

function Highlighted({ text, terms, tone = 'exact' }: { text: string; terms: string[]; tone?: 'exact' | 'partial' }) {
  // SEARCH-30: exact matches keep the yellow mark; partial matches (stemmed / typo
  // recovery) get a visibly lighter tint, so the highlighting never overstates.
  const markClass =
    tone === 'partial'
      ? 'bg-yellow-50 font-medium dark:bg-yellow-900 dark:text-yellow-100'
      : 'bg-yellow-200 font-medium dark:bg-yellow-700 dark:text-yellow-50';
  return (
    <>
      {splitHighlight(text, terms).map((segment, index) =>
        segment.match ? (
          <mark key={index} role="mark" className={markClass}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Sibling window and child cap for the mini-tree (SEARCH-33). */
const MINI_TREE_SIBLINGS = 5;
const MINI_TREE_CHILDREN = 8;

/** Where the reader's chosen modal size lives (SEARCH-33). */
const MODAL_SIZE_STORAGE_KEY = 'atlas-search-modal-size';
const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const RESIZE_HANDLE_CLASS: Record<ResizeEdge, string> = {
  n: 'absolute inset-x-3 top-0 z-20 h-1.5 cursor-n-resize touch-none',
  s: 'absolute inset-x-3 bottom-0 z-20 h-1.5 cursor-s-resize touch-none',
  e: 'absolute inset-y-3 right-0 z-20 w-1.5 cursor-e-resize touch-none',
  w: 'absolute inset-y-3 left-0 z-20 w-1.5 cursor-w-resize touch-none',
  ne: 'absolute top-0 right-0 z-20 h-3 w-3 cursor-ne-resize touch-none',
  nw: 'absolute top-0 left-0 z-20 h-3 w-3 cursor-nw-resize touch-none',
  se: 'absolute right-0 bottom-0 z-20 h-3 w-3 cursor-se-resize touch-none',
  sw: 'absolute bottom-0 left-0 z-20 h-3 w-3 cursor-sw-resize touch-none',
};

/** The portal deep link for a document — UUID when it has one (stable), doc_no otherwise. */
function atlasHref(doc: FlatAtlasDocument): string {
  const target = (doc.source.uuid as string | null | undefined) ?? doc.doc_no;
  const path = typeof window === 'undefined' ? '' : window.location.pathname;
  return `${path}#${target}`;
}

/**
 * SEARCH-33: a local mini-tree around the result — ancestors as an indented spine,
 * the focus highlighted among a window of its siblings, direct children below. A
 * click on a node **re-centers** the tree on it (explore without leaving search);
 * the ↗ link on every node opens the portal in a **new tab** with the tree expanded
 * there (the portal is the real tree — no duplicate widget).
 */
function MiniTree({ doc, treeContext }: { doc: FlatAtlasDocument; treeContext: ReturnType<typeof buildTreeContext> }) {
  // Mounted per row (the peek renders under a keyed row), so the initial focus always
  // matches the row's document; re-centering is purely local state.
  const [focus, setFocus] = useState(doc);

  const ancestors = treeContext.ancestorsOf(focus.id);
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
  const allSiblings = parent ? treeContext.childrenOf(parent.id) : [focus];
  const focusIndex = Math.max(
    0,
    allSiblings.findIndex((sibling) => sibling.id === focus.id),
  );
  const windowStart = Math.max(0, Math.min(focusIndex - 2, allSiblings.length - MINI_TREE_SIBLINGS));
  const siblings = allSiblings.slice(windowStart, windowStart + MINI_TREE_SIBLINGS);
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(0, allSiblings.length - windowStart - MINI_TREE_SIBLINGS);
  const children = treeContext.childrenOf(focus.id);

  const node = (entry: FlatAtlasDocument, depth: number) => {
    const isFocus = entry.id === focus.id;
    return (
      <div
        key={entry.id}
        data-testid="tree-node"
        style={{ paddingLeft: depth * 14 }}
        className="flex items-center gap-1"
      >
        <span className="font-mono text-[10px] text-slate-400">{entry.doc_no}</span>
        {isFocus ? (
          <span aria-current="true" className="font-semibold text-slate-900 dark:text-slate-100">
            {entry.name || entry.doc_no}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setFocus(entry)}
            title="Show this node's surroundings"
            className="text-left text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
          >
            {entry.name || entry.doc_no}
          </button>
        )}
        {entry.id === doc.id && !isFocus && <span className="text-slate-400">·&nbsp;this result</span>}
        {entry.id === doc.id && isFocus && <span className="text-amber-500">★</span>}
        <a
          href={atlasHref(entry)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${entry.name || entry.doc_no} in the Atlas tree`}
          title="Open in the Atlas tree (small window)"
          className="text-slate-400 hover:text-blue-600 dark:hover:text-blue-300"
          onClick={(event) => {
            // A small window on top of the portal (review feedback), not a new
            // main window; the href stays for middle-click/new-tab purists.
            event.stopPropagation();
            event.preventDefault();
            window.open(atlasHref(entry), 'atlas-tree-popup', 'noopener,noreferrer,popup=yes,width=1000,height=750');
          }}
        >
          ↗
        </a>
      </div>
    );
  };

  const focusDepth = ancestors.length;
  return (
    <div
      data-testid="result-context"
      onClick={(event) => event.stopPropagation()}
      className="mt-2 space-y-0.5 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-slate-300"
    >
      {ancestors.map((ancestor, depth) => node(ancestor, depth))}
      {hiddenBefore > 0 && (
        <div style={{ paddingLeft: focusDepth * 14 }} className="text-slate-400">
          … {hiddenBefore} more above
        </div>
      )}
      {siblings.map((sibling) => (
        <div key={sibling.id}>
          {node(sibling, focusDepth)}
          {sibling.id === focus.id && children.slice(0, MINI_TREE_CHILDREN).map((child) => node(child, focusDepth + 1))}
          {sibling.id === focus.id && children.length > MINI_TREE_CHILDREN && (
            <div style={{ paddingLeft: (focusDepth + 1) * 14 }} className="text-slate-400">
              … +{children.length - MINI_TREE_CHILDREN} more
            </div>
          )}
        </div>
      ))}
      {hiddenAfter > 0 && (
        <div style={{ paddingLeft: focusDepth * 14 }} className="text-slate-400">
          … {hiddenAfter} more below
        </div>
      )}
    </div>
  );
}

/** Pills mirror the syntax they came from: "phrase", 'exact', -word, key:value. */
function operatorLabel(operator: ParsedQuery['operators'][number]): string {
  if (operator.key === 'phrase') return `"${operator.value}"`;
  if (operator.key === 'exact') return `'${operator.value}'`;
  if (operator.key === 'not') return `-${operator.value}`;
  return `${operator.key}:${operator.value}`;
}

/**
 * SEARCH-38: the Search-tools menu. Every row is an ACTION — clicking loads the
 * mode's template into the box and the suggestion machinery takes over. Behaviors of
 * the default search (typo tolerance, doc-number ranking, UUID jumps, addresses,
 * chainlog ids) are deliberately NOT listed here: they are not options, and the UI
 * explains them at the point of use (the jump notice, the amber unknown-type pill,
 * the vocabulary notice) — the agreed principle, 2026-09-03.
 */
const SEARCH_TOOL_MODES: Array<{
  template: string;
  cursorBack?: number;
  name: string;
  explanation: string;
  example: string;
}> = [
  {
    template: 'in:',
    name: 'Search in a section',
    explanation: 'Only results from one part of the Atlas — a tree appears to pick from',
    example: 'in:A.2.10',
  },
  {
    template: 'type:',
    name: 'Filter by type',
    explanation: 'Only documents of one kind — Core, Article, Annotation…',
    example: 'type:Annotation',
  },
  {
    template: 'title:',
    name: 'Search in titles',
    explanation: 'Match your words in document names only',
    example: 'title:facilitator',
  },
  {
    template: '""',
    cursorBack: 1,
    name: 'Exact phrase',
    explanation: 'These words, together, in this order',
    example: '"properly implemented"',
  },
  {
    template: "''",
    cursorBack: 1,
    name: 'Exact + case',
    explanation: 'Like exact phrase, and capitalization must match too',
    example: "'delegatedSigners'",
  },
  {
    template: '-',
    name: 'Exclude a word',
    explanation: 'Hide documents containing it',
    example: 'alignment -slippery',
  },
];

function SearchToolsMenu({ onPick }: { onPick: (template: string, cursorBack?: number) => void }) {
  return (
    <div className="w-full">
      {SEARCH_TOOL_MODES.map((mode) => (
        <button
          key={mode.name}
          type="button"
          onClick={() => onPick(mode.template, mode.cursorBack)}
          className="block w-full rounded px-1.5 py-1 text-left hover:bg-slate-100 dark:hover:bg-zinc-800"
        >
          <span className="font-medium text-slate-800 dark:text-slate-100">{mode.name}</span>{' '}
          <code className="font-mono text-[10px] text-slate-400">{mode.example}</code>
          <span className="block text-slate-500 dark:text-slate-400">{mode.explanation}</span>
        </button>
      ))}
    </div>
  );
}

// SEARCH-66: one result row as a memoized component — a selection change
// repaints the affected rows, not the whole list. Everything stable lives in
// `ctx` (one memoized object); the only per-row volatile prop is `selected`.
interface ResultRowEntry {
  hit: AtlasSearchHit;
  doc: FlatAtlasDocument;
  group?: SegmentGroupSummary<AtlasSearchHit>;
  member: boolean;
  weak: boolean;
  /** SEARCH-71: present on Related rows — the stated connection. */
  related?: { reason: string; strength: number };
}

interface ResultRowContext {
  queryContentTokens: string[];
  resultPaths: FlatAtlasDocument['breadcrumb'][];
  familyMembers: (docNo: string) => string[];
  peekedIds: number[];
  relatedIds: number[];
  expandedIds: number[];
  toggleGroup: (id: number) => void;
  toggleContext: (id: number) => void;
  toggleRelated: (id: number) => void;
  navigateTo: (docNo: string) => void;
  selectAt: (index: number) => void;
  optionId: (index: number) => string;
  treeContext: ReturnType<typeof buildTreeContext>;
  graphState: 'idle' | 'loading' | 'ready' | 'unavailable';
  graph: AtlasGraph | null;
  idByDocNo: Map<string, number>;
  documents: FlatAtlasDocument[];
}

const ResultRow = memo(function ResultRow({
  row,
  index,
  selected,
  ctx,
}: {
  row: ResultRowEntry;
  index: number;
  selected: boolean;
  ctx: ResultRowContext;
}) {
  const { hit, doc, group, member, weak } = row;
  const {
    queryContentTokens,
    resultPaths,
    familyMembers,
    peekedIds,
    relatedIds,
    expandedIds,
    toggleGroup,
    toggleContext,
    toggleRelated,
    navigateTo,
    selectAt,
    optionId,
    treeContext,
    graphState,
    graph,
    idByDocNo,
    documents,
  } = ctx;
  const vocabularyMatch = Boolean(hit.vocabulary && hit.provenance !== 'rung');
  const partialTone = hit.provenance === 'relaxed' || vocabularyMatch;
  // SEARCH-53: the chip reports match EVIDENCE, not the retrieval tier —
  // the strict pass admits stemmed/prefix/typo matches, and a match that
  // lives only in generated expansion text is never "exact".
  const strictEvidence = hit.provenance === 'strict' && !vocabularyMatch ? classifyHit(queryContentTokens, hit) : null;
  const strictLabel = strictEvidence
    ? strictEvidence.expansionOnly
      ? 'related phrasing'
      : EVIDENCE_LABEL[strictEvidence.evidence]
    : null;
  const matchNote = hit.provenance && !vocabularyMatch ? originNote(hit) : null;
  // Preview the matched extra field under its label when the terms hit
  // there and not in the content, mirroring the old modal (spec §6).
  const extraField =
    hit.fields.includes('extras') && !hit.fields.includes('content')
      ? findMatchingExtraField(doc.source, hit.terms)
      : null;
  // A semantic row matched by meaning, not words: preview the expansion
  // text (SEARCH-17 paraphrase) that carries the similarity, not the
  // content the query never touched (SEARCH-30).
  const previewText = extraField
    ? extraField.value
    : hit.provenance === 'rung' && doc.expansion
      ? doc.expansion
      : doc.content;
  // What tells this row apart from the others on screen; empty when
  // nothing does, and then no label line is rendered (spec §3.6).
  const pathLabel = distinguishingSegments(resultPaths, index);
  // SEARCH-22's adopted collapse policy: interchangeable copies are
  // collapsed to the highest-ranked member; the row discloses where
  // else the same content lives.
  const alsoUnder = familyMembers(doc.doc_no);

  return (
    <div
      key={member ? `member-${doc.id}` : doc.id}
      id={optionId(index)}
      data-result-index={index}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => {
        // SEARCH-75: a selection drag ends on the row — copying text must
        // never navigate away and close the window.
        if (window.getSelection()?.toString()) return;
        navigateTo(doc.doc_no);
      }}
      onMouseEnter={() => selectAt(index)}
      className={`cursor-pointer rounded-lg p-3 transition-all ${
        selected ? 'bg-blue-100 dark:bg-blue-950' : 'bg-slate-100 dark:bg-zinc-800'
      } ${member ? 'ml-6 border-l-2 border-slate-300 dark:border-zinc-600' : ''} ${weak ? 'opacity-70' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-block rounded-md bg-white px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-zinc-900 dark:text-slate-200">
          <Highlighted text={doc.doc_no} terms={hit.terms} tone={partialTone ? 'partial' : 'exact'} />
        </span>
        <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${typeColor(doc.type)}`}>
          {doc.type}
        </span>
        {(() => {
          // SEARCH-70: a chip that merely restates its section ("exact match"
          // inside Exact matches, "partial match" inside Partial, "similar"
          // inside Similar) is noise — only informative labels render.
          if (!hit.provenance && !vocabularyMatch) return null;
          const label = vocabularyMatch
            ? 'Atlas vocabulary'
            : hit.provenance === 'strict'
              ? (strictLabel ?? 'exact match')
              : hit.provenance === 'relaxed'
                ? 'partial match'
                : hit.provenance === 'expanded'
                  ? 'abbreviation'
                  : weak
                    ? 'weak match'
                    : 'similar';
          if (label === 'exact match' || label === 'partial match' || label === 'similar') return null;
          return (
            <span
              data-testid="result-provenance"
              className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${
                vocabularyMatch
                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                  : hit.provenance === 'strict'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                    : hit.provenance === 'relaxed'
                      ? 'bg-slate-200 text-slate-600 dark:bg-zinc-700 dark:text-slate-300'
                      : hit.provenance === 'expanded'
                        ? 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
              }`}
            >
              {label}
            </span>
          );
        })()}
      </div>

      <div className="mb-1 font-semibold text-slate-900 dark:text-slate-100">
        <Highlighted text={doc.name || '<Untitled>'} terms={hit.terms} tone={partialTone ? 'partial' : 'exact'} />
      </div>

      {row.related && (
        <div data-testid="related-reason" className="mb-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
          {row.related.reason}
        </div>
      )}

      {pathLabel.length > 0 && (
        <div data-testid="result-path" className="mb-1 text-xs text-slate-500 dark:text-slate-400">
          {pathLabel.join(' › ')}
        </div>
      )}

      {alsoUnder.length > 0 && (
        <div data-testid="result-also-under" className="mb-1 text-xs text-slate-400 dark:text-slate-500">
          also under: {alsoUnder.slice(0, 3).join(', ')}
          {alsoUnder.length > 3 ? ` +${alsoUnder.length - 3} more` : ''}
        </div>
      )}

      {previewText && (
        <div className="text-sm text-slate-600 dark:text-slate-400">
          {extraField && <span className="font-medium text-slate-700 dark:text-slate-300">{extraField.label}: </span>}
          <Highlighted
            text={buildSnippet(previewText, hit.terms)}
            terms={hit.terms}
            tone={partialTone ? 'partial' : 'exact'}
          />
        </div>
      )}

      {matchNote && (
        <div data-testid="match-origin-note" className="text-xs text-slate-400 dark:text-slate-500">
          {matchNote}
        </div>
      )}

      <div className="flex items-center gap-3">
        {group && (
          <button
            type="button"
            data-testid="result-group-toggle"
            onClick={(event) => {
              event.stopPropagation();
              toggleGroup(hit.id);
            }}
            className="mt-1 block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {expandedIds.includes(hit.id)
              ? 'hide these'
              : // SEARCH-72: say the true criterion — same section, not similarity.
                `+${group.hidden.length} more from this section${group.label ? ` · ${group.label}` : ''}`}
          </button>
        )}
        <button
          type="button"
          data-testid="result-context-toggle"
          onClick={(event) => {
            event.stopPropagation();
            toggleContext(doc.id);
          }}
          className="mt-1 block text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
        >
          {peekedIds.includes(doc.id) ? 'hide Atlas tree' : 'Atlas tree'}
        </button>
        <button
          type="button"
          data-testid="result-related-toggle"
          onClick={(event) => {
            event.stopPropagation();
            toggleRelated(doc.id);
          }}
          className="mt-1 block text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
        >
          {relatedIds.includes(doc.id) ? 'hide related' : 'related documents'}
        </button>
      </div>

      {peekedIds.includes(doc.id) && <MiniTree doc={doc} treeContext={treeContext} />}

      {relatedIds.includes(doc.id) && (
        <div
          data-testid="related-documents"
          onClick={(event) => event.stopPropagation()}
          className="mt-2 rounded-md border border-slate-200 bg-white p-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          {(graphState === 'idle' || graphState === 'loading') && (
            <span className="block px-1 py-0.5 text-slate-400">Loading related documents…</span>
          )}
          {graphState === 'unavailable' && (
            <span className="block px-1 py-0.5 text-slate-400">
              Related information isn’t available for this Atlas version.
            </span>
          )}
          {graphState === 'ready' &&
            graph &&
            (() => {
              const entries = relatedDocuments(doc.doc_no, graph, (candidate) => idByDocNo.has(candidate));
              if (entries.length === 0) {
                return <span className="block px-1 py-0.5 text-slate-400">No related documents recorded.</span>;
              }
              return entries.map((entry) => {
                const relatedDoc = documents[idByDocNo.get(entry.docNo)!];
                return (
                  <button
                    key={entry.docNo}
                    type="button"
                    onClick={() => navigateTo(entry.docNo)}
                    className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-slate-100 dark:hover:bg-zinc-800"
                  >
                    <span className="font-mono text-[10px] text-slate-400">{entry.docNo} </span>
                    {relatedDoc.name || entry.docNo}
                    <span className="text-slate-400"> — {describeReason(entry.reason, graph)}</span>
                  </button>
                );
              });
            })()}
        </div>
      )}
    </div>
  );
});

export default function SearchModal({
  scopeTrees,
  isOpen,
  onClose,
  queryRewriteEnabled = false,
  answersEnabled = false,
}: SearchModalProps) {
  const {
    ready,
    documents,
    types,
    search,
    probeStrictCount,
    upgradeSearch,
    familyMembers,
    abbreviationMeaningsOf,
    searchMode,
    denseStatus,
  } = useAtlasSearch(scopeTrees);
  const { recents, remember } = useRecentSearches();

  const [query, setQuery] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  // `keyboard` records HOW the row was selected: only an arrow-key choice arms
  // Enter (SEARCH-78) — hover and the default first row never do.
  // The selection is recorded by DOCUMENT (plus member flag), never by list position:
  // the async dense upgrade recomposes the list under the same key (bug 7).
  const [selection, setSelection] = useState<{ key: string; docId: number | null; member: boolean; keyboard: boolean }>(
    {
      key: '',
      docId: null,
      member: false,
      keyboard: false,
    },
  );
  // Which Tools panel is open (inline panels — see the Tools row comment). The
  // Section box was removed in SEARCH-36: `in:` filters come from typed syntax,
  // completed by the inline suggestions below the input.
  const [openTool, setOpenTool] = useState<null | 'help'>(null);
  const [appliedRewrite, setAppliedRewrite] = useState<AppliedRewrite | null>(null);
  const [rewriteStatus, setRewriteStatus] = useState<'idle' | 'loading'>('idle');
  const [rewriteError, setRewriteError] = useState('');

  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  // Scoped so a second SearchModal instance cannot collide on DOM ids.
  const instanceId = useId();
  const listboxId = `atlas-search-results-${instanceId}`;
  const optionId = useCallback((index: number) => `atlas-search-result-${instanceId}-${index}`, [instanceId]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rewriteRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);

  const rootScopes = useMemo(
    () =>
      [
        ...new Set(
          scopeTrees
            .filter((tree) => tree.type === 'Scope')
            .map((tree) => tree.name?.normalize('NFKC').trim().replace(/\s+/g, ' '))
            .filter((name): name is string => Boolean(name)),
        ),
      ].slice(0, MAX_QUERY_REWRITE_SCOPES),
    [scopeTrees],
  );

  // SEARCH-82: exactly two capital letters are an abbreviation lookup — the one
  // deliberately case-sensitive input in the app. The engine then searches the
  // recorded phrase; lowercase "ad" keeps the too-short notice, and general
  // search keeps its three-character minimum.
  // SEARCH-83: an acronym with several recorded meanings searches nothing —
  // the meanings render as choices and the reader picks one.
  const acronymMeanings = useMemo(() => {
    const raw = debouncedQuery.trim();
    return /^[A-Z]{2}$/.test(raw) ? abbreviationMeaningsOf(foldText(raw)) : null;
  }, [debouncedQuery, abbreviationMeaningsOf]);
  const acronymEntry = acronymMeanings && acronymMeanings.phrases.length === 1 ? acronymMeanings : null;
  const acronymChoices = acronymMeanings && acronymMeanings.phrases.length > 1 ? acronymMeanings : null;
  const engineQuery = acronymEntry ? acronymEntry.phrases[0] : debouncedQuery;

  // SEARCH-34: operator syntax is parsed out of the box — the engine searches the
  // residual terms, operators feed the same measured filter machinery as the chips.
  const parsed = useMemo(() => parseQuerySyntax(engineQuery), [engineQuery]);
  const trimmedQuery = parsed.terms;
  const filtersOnly = parsed.operators.length > 0; // e.g. `type:Annotation` alone
  const hasQuery = trimmedQuery.length >= MIN_QUERY_LENGTH || Boolean(parsed.uuidJump) || filtersOnly;
  const isTooShort = debouncedQuery.trim().length > 0 && !hasQuery;

  // Ancestry filter for the selected scope chips. Ancestry is deliberately not indexed
  // (spec §3.3): the predicate reads the breadcrumbs the modal already holds, and the
  // engine applies it inside every pass so the cap counts only filtered results.
  const includeId = useMemo(() => {
    if (selectedScopes.length === 0) return undefined;
    const wanted = new Set(selectedScopes);
    const rootNames = new Set(rootScopes);
    return (id: number) => {
      const document = documents[id];
      return Boolean(
        document &&
        ((document.type === 'Scope' && rootNames.has(document.name) && wanted.has(document.name)) ||
          document.breadcrumb.some((ancestor) => wanted.has(ancestor))),
      );
    };
  }, [documents, rootScopes, selectedScopes]);

  // SEARCH-31: tree accessors for the per-row peek — hoisted here because the
  // SEARCH-34 subtree filters below need them before the engine calls.
  const treeContext = useMemo(() => buildTreeContext(documents), [documents]);
  // SEARCH-52: agents and scopes, derived from the tree — the disambiguation lexicon.
  const entityLexicon = useMemo(() => buildEntityLexicon(documents), [documents]);
  // SEARCH-53: the query's unstemmed content tokens, for match-evidence classification.
  const queryContentTokens = useMemo(() => tokenizeQueryUnstemmed(parsed.terms), [parsed.terms]);
  // SEARCH-70: the stems of the query's content words — the exact test's input.
  const exactStems = useMemo(() => queryStems(parsed.terms), [parsed.terms]);

  // SEARCH-34: operator filters merged with the UI state, feeding the exact filter
  // machinery the chips already use (types option + includeId — dense rung included).
  const engineTypes = useMemo(() => {
    const matched = parsed.types
      .map((value) => types.find((known) => (known as string).toLowerCase() === value.toLowerCase()))
      .filter((value): value is (typeof types)[number] => Boolean(value));
    return [...new Set([...selectedTypes, ...matched])];
  }, [parsed.types, selectedTypes, types]);
  // `type:` values that name no real node type — warned about, never an error.
  const unknownTypes = useMemo(
    () =>
      parsed.types.filter((value) => !types.some((known) => (known as string).toLowerCase() === value.toLowerCase())),
    [parsed.types, types],
  );

  const idByDocNo = useMemo(() => new Map(documents.map((entry) => [entry.doc_no, entry.id])), [documents]);
  const subtreeIds = useMemo(() => {
    const roots = parsed.scopes;
    if (roots.length === 0) return null;
    const set = new Set<number>();
    for (const scope of roots) {
      const rootId = idByDocNo.get(scope);
      if (rootId === undefined) continue;
      const queue = [rootId];
      while (queue.length > 0) {
        const id = queue.pop()!;
        if (set.has(id)) continue;
        set.add(id);
        for (const child of treeContext.childrenOf(id)) queue.push(child.id);
      }
    }
    return set;
  }, [parsed.scopes, idByDocNo, treeContext]);
  // SEARCH-35: phrase / exact / exclusion predicates over the raw document text,
  // applied through includeId so every pass — dense rung included — honours them.
  // Plain queries build no predicate: their ranking is untouched by construction.
  const textFilter = useMemo(() => {
    if (parsed.phrases.length === 0 && parsed.exactPhrases.length === 0 && parsed.excludes.length === 0) return null;
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Unicode-aware word boundaries: JS \b is ASCII-only, so `é\b` never matches —
    // accented Atlas text ("Société") would silently fail phrase matching.
    const wordy = (value: string) => `(?<![\\p{L}\\p{N}_])${escape(value).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`;
    const checks = [
      ...parsed.phrases.map((phrase) => {
        const pattern = new RegExp(wordy(phrase), 'iu');
        return (text: string) => pattern.test(text);
      }),
      ...parsed.exactPhrases.map((phrase) => {
        const pattern = new RegExp(wordy(phrase), 'u');
        return (text: string) => pattern.test(text);
      }),
      ...parsed.excludes.map((word) => {
        const pattern = new RegExp(wordy(word), 'iu');
        return (text: string) => !pattern.test(text);
      }),
    ];
    const cache = new Map<number, boolean>();
    return (id: number) => {
      let ok = cache.get(id);
      if (ok === undefined) {
        const document = documents[id];
        const text = `${document.name} ${document.content} ${document.extras}`.replace(/\s+/g, ' ');
        ok = checks.every((check) => check(text));
        cache.set(id, ok);
      }
      return ok;
    };
  }, [parsed.phrases, parsed.exactPhrases, parsed.excludes, documents]);

  const engineIncludeId = useMemo(() => {
    if (!subtreeIds && !includeId && !textFilter) return undefined;
    return (id: number) =>
      (includeId ? includeId(id) : true) &&
      (subtreeIds ? subtreeIds.has(id) : true) &&
      (textFilter ? textFilter(id) : true);
  }, [includeId, subtreeIds, textFilter]);
  const engineFields = useMemo(() => (parsed.titleOnly ? ['name'] : undefined), [parsed.titleOnly]);
  // Quoted phrases are an explicit request for literal text (SEARCH-35); never rewrite
  // their words through SEARCH-09's vocabulary map.
  const applyVocabulary = parsed.phrases.length === 0 && parsed.exactPhrases.length === 0;

  // A UUID query is a jump: resolve the (prefix of the) id directly.
  const uuidJumpDoc = useMemo(() => {
    if (!parsed.uuidJump) return null;
    for (const document of documents) {
      const uuid = (document.source.uuid as string | null | undefined)?.replace(/-/g, '').toLowerCase();
      if (uuid?.startsWith(parsed.uuidJump)) return document;
    }
    return null;
  }, [parsed.uuidJump, documents]);

  // SEARCH-57: the title-keyword index behind `title:` suggestions, built once per
  // tree like the entity lexicon.
  const titleKeywordIndex = useMemo(() => buildTitleKeywordIndex(documents), [documents]);

  // SEARCH-36: inline operator autocomplete. `type:` lists the node types; `in:` is a
  // drill-down tree navigator (the agreed design, corrected 2026-09-03): an empty
  // value lists the scopes, a resolved value lists that node plus ALL its children in
  // a scrollable panel, a partial value filters the current level. Clicking a node
  // with children descends; clicking a leaf — or pressing Enter — completes the
  // operator. No caps: one level at a time, scrolled. SEARCH-57 adds `title:`: a flat
  // list of title keywords with honest counts — plain title frequency on its own,
  // titles-containing-all counts once the query carries other title-restricted terms
  // (every term is name-restricted under `title:`, so they all form the context).
  const suggestions = useMemo(() => {
    const match = /(^|\s)(in|type|title):([^\s"']*)$/i.exec(query);
    if (!match) return null;
    const key = match[2].toLowerCase() as 'in' | 'type' | 'title';
    const value = match[3];
    if (key === 'title') {
      const context = titleTokens(parseQuerySyntax(query.slice(0, match.index)).terms);
      const options = suggestTitleKeywords(titleKeywordIndex, value, context).map((suggestion) => ({
        doc: null as FlatAtlasDocument | null,
        value: suggestion.keyword,
        label: suggestion.keyword,
        count: suggestion.count as number | undefined,
        descend: false,
      }));
      return options.length > 0 ? { key, self: null as FlatAtlasDocument | null, options } : null;
    }
    if (key === 'type') {
      const needle = value.toLowerCase();
      const options = (types as string[])
        .filter((known) => known.toLowerCase().includes(needle))
        .map((known) => ({
          doc: null as FlatAtlasDocument | null,
          value: known.includes(' ') ? known.replace(/ /g, '_') : known,
          label: known,
          count: undefined as number | undefined,
          descend: false,
        }));
      return options.length > 0 ? { key, self: null as FlatAtlasDocument | null, options } : null;
    }
    const needle = value.toLowerCase();
    const self = value ? (documents.find((d) => d.doc_no.toLowerCase() === needle) ?? null) : null;
    let level: FlatAtlasDocument[];
    if (self) {
      level = treeContext.childrenOf(self.id);
    } else {
      // The deepest resolvable ancestor of the typed value hosts the level; roots otherwise.
      const parentNo = value.includes('.') ? value.slice(0, value.lastIndexOf('.')) : '';
      const parent = parentNo ? documents.find((d) => d.doc_no.toLowerCase() === parentNo.toLowerCase()) : null;
      level = (parent ? treeContext.childrenOf(parent.id) : documents.filter((d) => d.parentId === null)).filter((d) =>
        d.doc_no.toLowerCase().startsWith(needle),
      );
    }
    const options = level.map((doc) => ({
      doc: doc as FlatAtlasDocument | null,
      value: doc.doc_no,
      label: doc.name || doc.doc_no,
      count: undefined as number | undefined,
      descend: treeContext.childrenOf(doc.id).length > 0,
    }));
    if (!self && options.length === 0) return null;
    return { key, self, options };
  }, [query, types, documents, treeContext, titleKeywordIndex]);

  // The key under which a result set (and the row selection) is current: any change to
  // the query or the filters starts a new key.
  const resultsKey = [debouncedQuery, selectedTypes.join(','), selectedScopes.join(','), searchMode].join('\u0000');

  // SEARCH-34: a filter-only query (`type:Annotation`, `in:A.1.2` on their own)
  // browses the matching documents in tree order — searching empty terms would
  // misreport "no documents found" for a perfectly valid filter.
  const browse =
    hasQuery &&
    parsed.terms.length < MIN_QUERY_LENGTH &&
    !parsed.uuidJump &&
    (engineTypes.length > 0 || Boolean(subtreeIds) || Boolean(textFilter));
  const keywordResults = useMemo(() => {
    if (!hasQuery) return { hits: [], total: 0 };
    if (browse) {
      const matching = documents.filter(
        (document) =>
          (engineTypes.length === 0 || engineTypes.includes(document.type)) &&
          (!engineIncludeId || engineIncludeId(document.id)),
      );
      return {
        hits: matching
          .slice(0, 100)
          .map((document): AtlasSearchHit => ({ id: document.id, score: 1, terms: [], fields: [] })),
        total: matching.length,
      };
    }
    return search(parsed.terms, {
      types: engineTypes,
      includeId: engineIncludeId,
      fields: engineFields,
      applyVocabulary,
    });
  }, [hasQuery, browse, documents, search, parsed.terms, engineTypes, engineIncludeId, engineFields, applyVocabulary]);

  // SEARCH-21: keyword results render immediately; when the engine decides the dense
  // rung applies to this query, the hybrid list replaces them under the same key. A
  // null upgrade means the keyword results stand (confident strict pass, no vector
  // artifacts, or any dense failure) — nothing re-renders.
  const [hybrid, setHybrid] = useState<{ key: string; results: UpgradedAtlasSearchResults } | null>(null);

  // SEARCH-25: a verified, cited answer over the current results. Keyed by resultsKey so
  // a stale answer never survives a query or filter change; the request is aborted on
  // close and on a new request. Failure never touches the result list.
  type AnswerState =
    | { key: string; state: 'loading' }
    | { key: string; state: 'done'; response: SearchAnswerResponse }
    | { key: string; state: 'error'; message: string };
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const answerRequestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // Browse mode (SEARCH-34) lists documents in tree order; a ranked upgrade landing
    // later would swap the listing under the reader (bug 2).
    if (!hasQuery || !ready || parsed.uuidJump || browse) return;
    let cancelled = false;
    void upgradeSearch(parsed.terms, {
      types: engineTypes,
      includeId: engineIncludeId,
      fields: engineFields,
      applyVocabulary,
    }).then((results) => {
      if (!cancelled && results) setHybrid({ key: resultsKey, results });
    });
    return () => {
      cancelled = true;
    };
  }, [
    hasQuery,
    ready,
    upgradeSearch,
    parsed.terms,
    parsed.uuidJump,
    browse,
    engineTypes,
    engineIncludeId,
    engineFields,
    applyVocabulary,
    resultsKey,
  ]);

  const { hits, total, vocabulary, abbreviation } = hybrid?.key === resultsKey ? hybrid.results : keywordResults;
  const groups = hybrid?.key === resultsKey ? hybrid.results.groups : undefined;
  // SEARCH-30: not a single query word matched — every row is a semantic guess.
  const noKeywordMatches = hybrid?.key === resultsKey ? (hybrid.results.noKeywordMatches ?? false) : false;

  // SEARCH-30: weak guesses (below the measured score line) never render in the list;
  // they live behind the "show weak matches" control at the end.
  const weakHits = useMemo(() => hits.filter((hit) => hit.weak), [hits]);

  const results = useMemo(() => {
    // SEARCH-34: a resolved UUID jump renders as a single direct hit.
    if (uuidJumpDoc) return [{ hit: { id: uuidJumpDoc.id, score: 1, terms: [], fields: [] }, doc: uuidJumpDoc }];
    return hits
      .filter((hit) => !hit.weak)
      .map((hit) => ({ hit, doc: documents[hit.id] }))
      .filter((entry) => Boolean(entry.doc));
  }, [hits, documents, uuidJumpDoc]);

  // SEARCH-29: category groups over the current ranking, keyed by their representative
  // row's document id (row indices shift as the list is filtered; ids do not). A
  // grouped-away member renders only behind its representative's inline expansion.
  // SEARCH-72: one display category per hit, shared by the grouping filter and
  // the section bucketing so they can never disagree.
  const hitCategoryOf = useMemo(() => {
    const map = new Map<number, SectionCategory>();
    for (const hit of hits) {
      const doc = documents[hit.id];
      if (doc) map.set(hit.id, displayCategoryOf(hit, doc, exactStems));
    }
    return map;
  }, [hits, documents, exactStems]);

  const groupByFirstId = useMemo(() => {
    const map = new Map<number, SegmentGroupSummary<AtlasSearchHit>>();
    for (const group of groups ?? []) {
      const repCategory = hitCategoryOf.get(group.firstId);
      // SEARCH-72: Exact matches are FLAT — no clustering of any
      // kind there; elsewhere a row folds behind a representative only when
      // both share a category. Unfolded members render as ordinary rows.
      if (!repCategory || repCategory === 'exact') continue;
      const hidden = group.hidden.filter((hit) => hitCategoryOf.get(hit.id) === repCategory);
      if (hidden.length > 0) map.set(group.firstId, { ...group, hidden });
    }
    return map;
  }, [groups, hitCategoryOf]);
  const hiddenIds = useMemo(() => {
    const set = new Set<number>();
    for (const group of groupByFirstId.values()) for (const hit of group.hidden) set.add(hit.id);
    return set;
  }, [groupByFirstId]);
  // Expanded groups, keyed like the selection: recorded under a stale key = collapsed.
  const [expansion, setExpansion] = useState<{ key: string; ids: number[] }>({ key: '', ids: [] });
  const expandedIds = useMemo(() => (expansion.key === resultsKey ? expansion.ids : NO_IDS), [expansion, resultsKey]);
  const toggleGroup = useCallback(
    (firstId: number) => {
      setExpansion((current) => {
        const ids = current.key === resultsKey ? current.ids : [];
        return {
          key: resultsKey,
          ids: ids.includes(firstId) ? ids.filter((id) => id !== firstId) : [...ids, firstId],
        };
      });
    },
    [resultsKey],
  );

  // SEARCH-30: weak matches revealed on demand, keyed like the selection.
  const [weakReveal, setWeakReveal] = useState<{ key: string; revealed: boolean }>({ key: '', revealed: false });
  const showWeak = weakReveal.key === resultsKey && weakReveal.revealed;
  const toggleWeak = useCallback(
    () =>
      setWeakReveal((current) => ({ key: resultsKey, revealed: !(current.key === resultsKey && current.revealed) })),
    [resultsKey],
  );

  // SEARCH-52: entity-aware disambiguation. Fires only when the plain query mixes ONE
  // entity (agent/scope) with concept words AND the engine's own thin-strict signal
  // says keyword search could not answer it (the dense rung ran, or nothing matched).
  // Deterministic end to end; chips rewrite the visible query onto shipped operators.
  // SEARCH-63: related documents with stated reasons. The graph artifact (0.74MB
  // gzipped) loads lazily on the FIRST expand only — never on modal open — and an
  // absent or stale artifact degrades to a quiet note.
  const [graphState, setGraphState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const graphRef = useRef<AtlasGraph | null>(null);
  const ensureGraph = useCallback(() => {
    setGraphState((current) => {
      if (current !== 'idle') return current;
      void tryLoadGraph(scopeTrees).then((graph) => {
        graphRef.current = graph;
        setGraphState(graph ? 'ready' : 'unavailable');
      });
      return 'loading';
    });
  }, [scopeTrees]);
  // SEARCH-84: template-or-silence question answering. The raw question ALSO
  // runs as a normal search below (byte-identical to typing it today); the
  // answer row is purely additive, and any failed resolution renders nothing.
  // Definitions need the structural data (recomputed when it becomes ready);
  // counts read the live document tree directly.
  const parsedQuestion = useMemo(() => parseQuestion(debouncedQuery), [debouncedQuery]);
  const questionAnswer = useMemo(
    () =>
      parsedQuestion
        ? answerQuestion(parsedQuestion, documents, graphState === 'ready' ? graphRef.current : null)
        : null,
    [parsedQuestion, documents, graphState],
  );

  const [relatedPeek, setRelatedPeek] = useState<{ key: string; ids: number[] }>({ key: '', ids: [] });
  const relatedIds = relatedPeek.key === resultsKey ? relatedPeek.ids : NO_IDS;
  const toggleRelated = useCallback(
    (id: number) => {
      ensureGraph();
      setRelatedPeek((current) => {
        const ids = current.key === resultsKey ? current.ids : [];
        return { key: resultsKey, ids: ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id] };
      });
    },
    [resultsKey, ensureGraph],
  );

  // The shared trigger (SEARCH-52/62): a plain query the keyword tiers could not
  // answer confidently — the dense rung ran, or nothing matched at all.
  const interpretationTrigger = useMemo(
    () =>
      hasQuery &&
      !parsed.uuidJump &&
      parsed.operators.length === 0 &&
      (noKeywordMatches || hits.some((hit) => hit.provenance === 'rung')),
    [hasQuery, parsed.uuidJump, parsed.operators.length, noKeywordMatches, hits],
  );

  const disambiguation = useMemo(() => {
    if (!interpretationTrigger) return null;
    const detected = detectEntityQuery(tokenizeQueryUnstemmed(parsed.terms), entityLexicon);
    if (!detected) return null;
    const concept = detected.conceptTokens.join(' ');
    const subtree = new Set<number>();
    const queue = [detected.entity.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      for (const child of treeContext.childrenOf(id)) queue.push(child.id);
    }
    return {
      entity: detected.entity,
      chips: [
        {
          key: 'within',
          label: `“${concept}” within ${detected.entity.name}`,
          count: probeStrictCount(concept, { includeId: (id) => subtree.has(id) }),
          rewrite: `in:${detected.entity.docNo} ${concept}`,
        },
        {
          key: 'everywhere',
          label: `“${concept}” everywhere`,
          count: probeStrictCount(concept),
          rewrite: concept,
        },
        {
          key: 'about',
          label: `about ${detected.entity.name}`,
          count: subtree.size,
          rewrite: detected.entity.token,
        },
      ],
    };
  }, [interpretationTrigger, parsed, entityLexicon, treeContext, probeStrictCount]);

  // SEARCH-62: graph interpretations — the KG's suggested readings of a query the
  // keyword tiers could not answer. The graph loads lazily WHEN the trigger fires
  // (a confident query never pays for it); chips carry honest strict counts and a
  // zero-count rewrite is never offered.
  // SEARCH-71: a standing Related section means the graph loads once per
  // session on the FIRST plain query (progressive, like the semantic tier) —
  // not only when a query struggles.
  useEffect(() => {
    if (hasQuery && !parsed.uuidJump && parsed.operators.length === 0) ensureGraph();
  }, [hasQuery, parsed.uuidJump, parsed.operators.length, ensureGraph]);
  const graphInterpretations = useMemo(() => {
    if (!interpretationTrigger || graphState !== 'ready' || !graphRef.current) return null;
    const chips = detectGraphInterpretations(engineQuery, graphRef.current)
      .map((chip) => ({ ...chip, count: probeStrictCount(chip.rewrite) }))
      .filter((chip) => chip.count > 0)
      .slice(0, 3);
    return chips.length > 0 ? chips : null;
  }, [interpretationTrigger, graphState, engineQuery, probeStrictCount]);

  // The base rows: the ranking minus grouped-away members, with each expanded
  // group's members inlined (indented) under their representative. Weak guesses are
  // kept apart — they render inside the Similar section (SEARCH-58) or, in the flat
  // fallback, at the end behind the toggle (SEARCH-30).
  const baseRows = useMemo<ResultRowEntry[]>(() => {
    return results.flatMap((entry) => {
      if (hiddenIds.has(entry.hit.id)) return [];
      const group = groupByFirstId.get(entry.hit.id);
      const base = { ...entry, group, member: false, weak: false };
      if (!group || !expandedIds.includes(entry.hit.id)) return [base];
      return [
        base,
        ...group.hidden
          .filter((hit) => !hit.weak)
          .map((hit) => ({ hit, doc: documents[hit.id], group: undefined, member: true, weak: false }))
          .filter((row) => Boolean(row.doc)),
      ];
    });
  }, [results, hiddenIds, groupByFirstId, expandedIds, documents]);
  const weakRows = useMemo<ResultRowEntry[]>(
    () =>
      weakHits
        .map((hit) => ({ hit, doc: documents[hit.id], group: undefined, member: false, weak: true }))
        .filter((row) => Boolean(row.doc)),
    [weakHits, documents],
  );

  // SEARCH-58: per-section "Show all" reveals, keyed like the selection — a stale
  // key means every section is back to its first SECTION_PAGE[category] rows.
  const [sectionReveal, setSectionReveal] = useState<{ key: string; categories: SectionCategory[] }>({
    key: '',
    categories: [],
  });
  const revealedCategories = useMemo(
    () => (sectionReveal.key === resultsKey ? sectionReveal.categories : []),
    [sectionReveal, resultsKey],
  );
  const revealSection = useCallback(
    (category: SectionCategory) => {
      setSectionReveal((current) => {
        const categories = current.key === resultsKey ? current.categories : [];
        return {
          key: resultsKey,
          // SEARCH-74: a toggle — "Show all" extends, "Show fewer" collapses back.
          categories: categories.includes(category)
            ? categories.filter((entry) => entry !== category)
            : [...categories, category],
        };
      });
    },
    [resultsKey],
  );

  // SEARCH-74: whole categories collapse behind their header (chevron click).
  const [collapsed, setCollapsed] = useState<{ key: string; categories: SectionCategory[] }>({
    key: '',
    categories: [],
  });
  const collapsedCategories = useMemo(
    () => (collapsed.key === resultsKey ? collapsed.categories : []),
    [collapsed, resultsKey],
  );
  const toggleCollapsed = useCallback(
    (category: SectionCategory) => {
      setCollapsed((current) => {
        const categories = current.key === resultsKey ? current.categories : [];
        return {
          key: resultsKey,
          categories: categories.includes(category)
            ? categories.filter((entry) => entry !== category)
            : [...categories, category],
        };
      });
    },
    [resultsKey],
  );

  // SEARCH-70: reveal state for each section's below-quality rows ("N weaker
  // matches hidden — show"), keyed like every other per-result-set state.
  const [qualityReveal, setQualityReveal] = useState<{ key: string; categories: SectionCategory[] }>({
    key: '',
    categories: [],
  });
  const qualityRevealed = useMemo(
    () => (qualityReveal.key === resultsKey ? qualityReveal.categories : []),
    [qualityReveal, resultsKey],
  );
  const toggleQuality = useCallback(
    (category: SectionCategory) => {
      setQualityReveal((current) => {
        const categories = current.key === resultsKey ? current.categories : [];
        return {
          key: resultsKey,
          categories: categories.includes(category)
            ? categories.filter((entry) => entry !== category)
            : [...categories, category],
        };
      });
    },
    [resultsKey],
  );

  // SEARCH-70: the stems of the query's content words — the exact test's input.
  // SEARCH-72: the diversity key — interchangeable-copy family where the census
  // knows one, else the parent section (the tree backbone).
  const diversityKeyOf = useCallback(
    (doc: FlatAtlasDocument) => {
      const family = familyMembers(doc.doc_no);
      if (family.length > 0) return `f:${[doc.doc_no, ...family].sort()[0]}`;
      return `p:${String(doc.parentId ?? 'root')}`;
    },
    [familyMembers],
  );

  // SEARCH-71: the Related rows — recorded connections of what the query
  // names, deduplicated against everything the list already shows. Empty until
  // the graph has loaded; the section appears progressively.
  const relatedEntries = useMemo<ResultRowEntry[]>(() => {
    if (!hasQuery || parsed.uuidJump || parsed.operators.length > 0) return [];
    if (graphState !== 'ready' || !graphRef.current) return [];
    // Exact keeps its documents; a doc in the looser categories may instead be
    // CLAIMED by Related (the reasoned category wins) — so only Exact rows are
    // excluded here, and the section bucketing below drops the claimed rows.
    const exclude = new Set(
      baseRows
        .filter((row) => !row.member && (hitCategoryOf.get(row.hit.id) ?? 'partial') === 'exact')
        .map((row) => row.doc.doc_no),
    );
    return relatedResults(parsed.terms, graphRef.current, {
      docNameOf: (docNo) => {
        const id = idByDocNo.get(docNo);
        return id === undefined ? null : documents[id].name || docNo;
      },
      exclude,
    }).map((entry) => {
      const id = idByDocNo.get(entry.docNo)!;
      return {
        hit: { id, score: 0, terms: [], fields: [] },
        doc: documents[id],
        group: undefined,
        member: false,
        weak: false,
        related: { reason: entry.reason, strength: entry.strength },
      };
    });
  }, [hasQuery, parsed, graphState, baseRows, idByDocNo, documents, hitCategoryOf]);

  // SEARCH-58: the ranking partitioned into match-category sections. The composed
  // list is contiguous by tier, so bucketing never reorders anything; an expanded
  // group's members follow their representative into its section. Null when no row
  // carries a provenance (browse mode, UUID jump): the flat list stands.
  const sections = useMemo(() => {
    if (uuidJumpDoc) return null;
    if (!baseRows.some((row) => row.hit.provenance) && weakRows.length === 0) return null;
    const buckets = new Map<SectionCategory, typeof baseRows>();
    // SEARCH-74: only connections at or above the floor ever render in Related, so
    // only those may claim a document away from its looser category (bug 9).
    const claimedByRelated = new Set(
      relatedEntries
        .filter((entry) => (entry.related?.strength ?? 0) >= RELATED_STRENGTH_FLOOR)
        .map((entry) => entry.doc.doc_no),
    );
    let current: SectionCategory = 'exact';
    let skipClaimed = false;
    for (const row of baseRows) {
      if (!row.member) {
        current = hitCategoryOf.get(row.hit.id) ?? displayCategoryOf(row.hit, row.doc, exactStems);
        // SEARCH-71: Related claimed this doc from a looser category — the row
        // (with its grouped members) renders there, with its reason.
        skipClaimed = current !== 'exact' && claimedByRelated.has(row.doc.doc_no);
      }
      if (skipClaimed) continue;
      const bucket = buckets.get(current);
      if (bucket) bucket.push(row);
      else buckets.set(current, [row]);
    }
    const ordered: Array<{
      category: SectionCategory;
      /** ALL top-level rows in the section (below-quality and weak included). */
      total: number;
      /** Above-quality top-level rows behind the "Show all" reveal. */
      hiddenCount: number;
      /** SEARCH-74: more rows than the page cap exist — the toggle renders. */
      pageable: boolean;
      revealed: boolean;
      weakCount: number;
      /** SEARCH-70: top-level rows under the category's quality bar. */
      belowBarCount: number;
      startIndex: number;
      rows: typeof baseRows;
    }> = [];
    let startIndex = 0;
    for (const category of SECTION_ORDER) {
      const all = category === 'related' ? relatedEntries : (buckets.get(category) ?? []);
      const weakCount =
        category === 'similar' ? weakRows.filter((row) => !claimedByRelated.has(row.doc.doc_no)).length : 0;
      // SEARCH-70: Partial rows below the coverage floor fold behind a reveal —
      // an ex-strict row covers every word by construction and always passes.
      let aboveBar = all;
      let belowBar: typeof baseRows = [];
      if (category === 'exact') {
        // SEARCH-72: diversity-ordered — nothing hidden, just interleaved.
        aboveBar = diversityInterleave(all, diversityKeyOf);
      } else if (category === 'related') {
        // SEARCH-74: the strength floor is ADMISSION — below-floor connections
        // are graph-mechanical noise and are dropped, not revealed.
        aboveBar = all.filter((row) => (row.related?.strength ?? 0) >= RELATED_STRENGTH_FLOOR);
        if (aboveBar.length === 0) continue;
      } else if (category === 'partial') {
        const above: typeof baseRows = [];
        const below: typeof baseRows = [];
        let rowBelow = false;
        for (const row of all) {
          // The floor judges the RELAXED tail only. Ex-strict rows matched every
          // word by the engine's own guarantee (typo/prefix repairs included), and
          // abbreviation-expanded rows matched the acronym's expansion — their
          // chips explain them; second-guessing either would hide honest matches.
          if (!row.member) {
            rowBelow =
              row.hit.provenance === 'relaxed' && coverageOf(exactStems, row.hit.terms) < PARTIAL_COVERAGE_FLOOR;
          }
          (rowBelow ? below : above).push(row);
        }
        aboveBar = above;
        belowBar = below;
      }
      if (all.length === 0 && weakCount === 0) continue;
      const topLevel = aboveBar.filter((row) => !row.member).length;
      const belowBarCount = belowBar.filter((row) => !row.member).length;
      const revealed = revealedCategories.includes(category);
      // Truncate on top-level rows only: members always stay with their representative.
      let visible = aboveBar;
      const page = SECTION_PAGE[category];
      if (!revealed && topLevel > page) {
        let seen = 0;
        let cut = aboveBar.length;
        for (let index = 0; index < aboveBar.length; index++) {
          if (!aboveBar[index].member && ++seen > page) {
            cut = index;
            break;
          }
        }
        visible = aboveBar.slice(0, cut);
      }
      let rows = visible;
      if (belowBar.length > 0 && qualityRevealed.includes(category)) rows = [...rows, ...belowBar];
      if (category === 'similar' && showWeak)
        rows = [...rows, ...weakRows.filter((row) => !claimedByRelated.has(row.doc.doc_no))];
      // SEARCH-74: a collapsed category keeps its header (and jump chip) only.
      if (collapsedCategories.includes(category)) rows = [];
      ordered.push({
        category,
        total: topLevel + belowBarCount + weakCount,
        hiddenCount: revealed ? 0 : Math.max(0, topLevel - page),
        pageable: topLevel > page,
        revealed,
        weakCount,
        belowBarCount,
        startIndex,
        rows,
      });
      startIndex += rows.length;
    }
    return ordered;
  }, [
    baseRows,
    weakRows,
    uuidJumpDoc,
    revealedCategories,
    showWeak,
    exactStems,
    hitCategoryOf,
    qualityRevealed,
    relatedEntries,
    diversityKeyOf,
    collapsedCategories,
  ]);

  // The rendered rows, flat and in render order — the single source for keyboard
  // selection, aria wiring and the distinguishing path labels.
  const rows = useMemo(() => {
    if (sections) return sections.flatMap((section) => section.rows);
    return showWeak ? [...baseRows, ...weakRows] : baseRows;
  }, [sections, baseRows, weakRows, showWeak]);

  // The paths on screen, in row order — the input to the distinguishing labels, which
  // are relative to what is rendered rather than to the corpus (spec §3.6).
  const resultPaths = useMemo(() => rows.map((entry) => entry.doc.breadcrumb), [rows]);

  // Ancestors that split the rendered rows (spec §3.4). Selected chips stay rendered
  // even once they stop splitting the filtered set, so they can always be turned off.
  const availableScopes = useMemo(() => scopeChips(resultPaths), [resultPaths]);

  // SEARCH-33: window-style resize — drag any border or corner (the dragged edge
  // moves, the opposite edge stays anchored), size persisted per browser. A null
  // panel means HeroUI's default responsive size.
  const [panel, setPanel] = useState<PanelRect | null>(null);
  // SEARCH-67: maximized fills the viewport; `panel` keeps the rect to restore to.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    try {
      const stored = window.localStorage.getItem(MODAL_SIZE_STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored) as { width?: number; height?: number; maximized?: boolean };
        setMaximized(Boolean(saved.maximized));
        if (typeof saved.width === 'number' && typeof saved.height === 'number') {
          setPanel(
            centeredPanel(
              { width: saved.width, height: saved.height },
              { width: window.innerWidth, height: window.innerHeight },
            ),
          );
          return;
        }
        setPanel(null);
        return;
      }
      setMaximized(false);
    } catch {
      // Storage unavailable (private mode etc.): the default size is always correct.
    }
    setPanel(null);
  }, [isOpen]);

  const persistPanel = useCallback((size: { width: number; height: number } | null, isMaximized: boolean) => {
    try {
      window.localStorage.setItem(
        MODAL_SIZE_STORAGE_KEY,
        JSON.stringify({ ...(size ? { width: size.width, height: size.height } : {}), maximized: isMaximized }),
      );
    } catch {
      // Best effort only.
    }
  }, []);

  const toggleMaximize = useCallback(() => {
    setMaximized((current) => {
      const next = !current;
      persistPanel(panel ? { width: panel.width, height: panel.height } : null, next);
      return next;
    });
  }, [panel, persistPanel]);

  const startResize = useCallback(
    (edge: ResizeEdge) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = event.currentTarget.parentElement?.getBoundingClientRect();
      // SEARCH-67: dragging an edge while maximized leaves maximized mode (window
      // convention) and continues the drag from the full-viewport rect.
      if (maximized) setMaximized(false);
      const start = maximized
        ? maximizedPanel(viewport)
        : (panel ??
          (rect && rect.width > 0
            ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            : centeredPanel({ width: 768, height: 640 }, viewport)));
      const startX = event.clientX;
      const startY = event.clientY;
      let latest = start;
      const onMove = (move: PointerEvent) => {
        latest = resizePanel(start, edge, move.clientX - startX, move.clientY - startY, viewport);
        setPanel(latest);
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        persistPanel({ width: latest.width, height: latest.height }, false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      // Touch: the browser may cancel the pointer (the gesture became a scroll). Treat it
      // exactly like release so no listener leaks and the on-screen size is what persists.
      window.addEventListener('pointercancel', finish);
    },
    [panel, maximized, persistPanel],
  );

  const [contextPeek, setContextPeek] = useState<{ key: string; ids: number[] }>({ key: '', ids: [] });
  const peekedIds = contextPeek.key === resultsKey ? contextPeek.ids : NO_IDS;
  const toggleContext = useCallback(
    (id: number) => {
      setContextPeek((current) => {
        const ids = current.key === resultsKey ? current.ids : [];
        return { key: resultsKey, ids: ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id] };
      });
    },
    [resultsKey],
  );

  const requestAnswer = useCallback(() => {
    answerRequestRef.current?.abort();
    const controller = new AbortController();
    answerRequestRef.current = controller;
    const key = resultsKey;
    setAnswer({ key, state: 'loading' });
    const docNos = results.slice(0, 10).map((entry) => entry.doc.doc_no);
    fetchAtlasAnswer(engineQuery, docNos, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setAnswer({ key, state: 'done', response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof AnswerClientError ? error.message : 'The answer service is unavailable right now.';
        setAnswer({ key, state: 'error', message });
      });
  }, [resultsKey, results, engineQuery]);
  const currentAnswer = answer?.key === resultsKey ? answer : null;

  const isIndexing = hasQuery && !ready;

  // The selection resets whenever the query or the filters change, with no effect
  // involved: a selection recorded under a different key simply is not current. Within
  // a key the selected row is found by document, so a recomposed list cannot move it.
  const selectedRowIndex =
    selection.key === resultsKey && selection.docId !== null
      ? rows.findIndex((row) => row.doc.id === selection.docId && row.member === selection.member)
      : -1;
  const selectedIndex = selectedRowIndex === -1 ? 0 : selectedRowIndex;
  /** True when the recorded selection names a row of the CURRENT list. */
  const selectionCurrent = selectedRowIndex !== -1;
  // SEARCH-66: the selection's source decides whether the list may auto-scroll.
  // Hover selection fires constantly while the USER scrolls (rows slide under the
  // stationary cursor), and scrolling the half-visible hovered row into view
  // hijacks that scroll — so only keyboard selection may move the list.
  const keyboardSelectRef = useRef(false);
  const selectAt = useCallback(
    (index: number, keyboard = false) => {
      const row = rows[index];
      setSelection({ key: resultsKey, docId: row?.doc.id ?? null, member: row?.member ?? false, keyboard });
    },
    [resultsKey, rows],
  );
  const selectByKeyboard = useCallback(
    (index: number) => {
      keyboardSelectRef.current = true;
      selectAt(index, true);
    },
    [selectAt],
  );

  // Keep the selected row visible during keyboard navigation — and only then.
  useEffect(() => {
    if (!keyboardSelectRef.current) return;
    keyboardSelectRef.current = false;
    listRef.current?.querySelector(`[data-result-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, rows]);

  // Fresh results start at the top (the old effect provided this incidentally by
  // scrolling row 0 into view whenever the result set changed).
  useEffect(() => {
    listRef.current?.querySelector('[data-result-index="0"]')?.scrollIntoView({ block: 'nearest' });
  }, [resultsKey]);

  useEffect(
    () => () => {
      rewriteRequestRef.current?.controller.abort();
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      rewriteRequestRef.current?.controller.abort();
      answerRequestRef.current?.abort();
    }
  }, [isOpen]);

  const replaceQuery = useCallback(
    (nextQuery: string) => {
      rewriteRequestRef.current?.controller.abort();
      rewriteRequestRef.current = null;
      setRewriteStatus('idle');
      setRewriteError('');
      if (appliedRewrite) {
        // Do not leave model-proposed filters silently attached when the reader begins a
        // new manual search. Preserve only the filters they had chosen themselves.
        setSelectedTypes(appliedRewrite.originalTypes);
        setSelectedScopes(appliedRewrite.originalScopes);
        setAppliedRewrite(null);
      }
      setQuery(nextQuery);
    },
    [appliedRewrite],
  );

  const ask = useCallback(async () => {
    const originalQuery = query.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (
      originalQuery.length < MIN_QUERY_LENGTH ||
      originalQuery.length > MAX_QUERY_REWRITE_LENGTH ||
      rewriteStatus === 'loading'
    )
      return;

    rewriteRequestRef.current?.controller.abort();
    const request = {
      id: (rewriteRequestRef.current?.id ?? 0) + 1,
      controller: new AbortController(),
    };
    rewriteRequestRef.current = request;
    const originalTypes = [...selectedTypes];
    const originalScopes = [...selectedScopes];
    setRewriteStatus('loading');
    setRewriteError('');

    try {
      const response = await rewriteAtlasQuery(
        {
          query: originalQuery,
          mode: 'terms-and-filters',
          context: 'glossary-examples',
          effort: 'low',
          availableScopes: rootScopes,
        },
        request.controller.signal,
      );
      if (rewriteRequestRef.current?.id !== request.id || request.controller.signal.aborted) return;

      // The server validates against the Atlas taxonomy; intersect once more with this
      // exact corpus so a temporarily absent/new type can never become an invisible
      // active filter in the modal.
      const applicableTypes = response.rewrite.filters.types.filter((type) => types.includes(type));
      const nextTypes = [...new Set([...originalTypes, ...applicableTypes])];
      const applicableScopes = response.rewrite.filters.scopes.filter((scope) => rootScopes.includes(scope));
      const scopes = [...new Set([...originalScopes, ...applicableScopes])];
      setQuery(response.searchQuery);
      setSelectedTypes(nextTypes);
      setSelectedScopes(scopes);
      setAppliedRewrite({ originalQuery, originalTypes, originalScopes, searchQuery: response.searchQuery });
    } catch (error) {
      if (request.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setRewriteError(error instanceof Error ? error.message : 'Query understanding failed. Your search is unchanged.');
    } finally {
      if (rewriteRequestRef.current?.id === request.id) {
        rewriteRequestRef.current = null;
        setRewriteStatus('idle');
      }
    }
  }, [query, rewriteStatus, selectedTypes, selectedScopes, rootScopes, types]);

  const searchMyWords = useCallback(() => {
    if (!appliedRewrite) return;
    rewriteRequestRef.current?.controller.abort();
    setQuery(appliedRewrite.originalQuery);
    setSelectedTypes(appliedRewrite.originalTypes);
    setSelectedScopes(appliedRewrite.originalScopes);
    setAppliedRewrite(null);
    setRewriteStatus('idle');
    setRewriteError('');
  }, [appliedRewrite]);

  const navigateTo = useCallback(
    (docNo: string) => {
      remember(appliedRewrite?.originalQuery ?? debouncedQuery);
      rewriteRequestRef.current?.controller.abort();
      setQuery('');
      setSelectedTypes([]);
      setSelectedScopes([]);
      setAppliedRewrite(null);
      setRewriteError('');
      onClose();
      dispatchExpandScopeEvent({ targetDocID: docNo });
    },
    [appliedRewrite, debouncedQuery, onClose, remember],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // CJK and other IME input: keys pressed while composing belong to the candidate
    // window, never to result navigation (bug 8).
    if (event.nativeEvent.isComposing) return;
    // SEARCH-36: while the drill-down suggestions are open on a resolved section,
    // Enter completes the operator instead of opening the selected result.
    if (event.key === 'Enter' && suggestions?.key === 'in' && suggestions.self) {
      event.preventDefault();
      replaceQuery(query.replace(/in:[^\s"']*$/i, `in:${suggestions.self.doc_no} `));
      return;
    }
    if (rows.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectByKeyboard((selectedIndex + 1) % rows.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectByKeyboard((selectedIndex - 1 + rows.length) % rows.length);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      // SEARCH-29: expand/collapse the selected row's group without leaving the input.
      const selected = rows[selectedIndex];
      const wantExpanded = event.key === 'ArrowRight';
      if (selected?.group && expandedIds.includes(selected.hit.id) !== wantExpanded) {
        event.preventDefault();
        toggleGroup(selected.hit.id);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // SEARCH-78: the search field only updates the results or does nothing.
      // Enter opens a row ONLY when the arrow keys chose it for this very
      // result set — never the implicit first row or a merely hovered one.
      if (!selectionCurrent || !selection.keyboard) return;
      const selected = rows[selectedIndex];
      if (selected) navigateTo(selected.doc.doc_no);
    }
  };

  const toggleType = (type: string) => {
    setSelectedTypes((current) =>
      current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type],
    );
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    );
  };

  const askQueryLength = query.normalize('NFKC').trim().replace(/\s+/g, ' ').length;
  const canAsk =
    askQueryLength >= MIN_QUERY_LENGTH &&
    askQueryLength <= MAX_QUERY_REWRITE_LENGTH &&
    rewriteStatus !== 'loading' &&
    appliedRewrite === null;

  // SEARCH-38: a Search-tools menu row loads its operator template into the box —
  // converging with typing: the suggestion machinery takes over immediately. Quote
  // templates land with the cursor between the quotes.
  const applyTool = (template: string, cursorBack = 0) => {
    const base = query.trimEnd();
    const next = base.length > 0 ? `${base} ${template}` : template;
    replaceQuery(next);
    setOpenTool(null);
    setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const position = next.length - cursorBack;
      input.setSelectionRange(position, position);
    }, 0);
  };

  // SEARCH-66: the stable half of every row's props, one object — its identity
  // changes only when a toggle, the graph, or the result set changes, never on
  // selection, so React.memo can skip untouched rows.
  const rowContext = useMemo<ResultRowContext>(
    () => ({
      queryContentTokens,
      resultPaths,
      familyMembers,
      peekedIds,
      relatedIds,
      expandedIds,
      toggleGroup,
      toggleContext,
      toggleRelated,
      navigateTo,
      selectAt,
      optionId,
      treeContext,
      graphState,
      graph: graphRef.current,
      idByDocNo,
      documents,
    }),
    [
      queryContentTokens,
      resultPaths,
      familyMembers,
      peekedIds,
      relatedIds,
      expandedIds,
      toggleGroup,
      toggleContext,
      toggleRelated,
      navigateTo,
      selectAt,
      optionId,
      treeContext,
      graphState,
      idByDocNo,
      documents,
    ],
  );
  const renderResultRow = (row: (typeof rows)[number], index: number) => (
    <ResultRow
      key={row.member ? `member-${row.doc.id}` : row.doc.id}
      row={row}
      index={index}
      selected={index === selectedIndex}
      ctx={rowContext}
    />
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="3xl"
      scrollBehavior="inside"
      // SEARCH-75: the window closes ONLY via the X button or a
      // click outside it — never from a stray Escape while working in it.
      isKeyboardDismissDisabled
      placement="top"
      classNames={{ base: panel || maximized ? 'm-0 max-w-none' : 'mt-20' }}
    >
      <ModalContent
        style={
          maximized
            ? {
                position: 'fixed',
                left: 0,
                top: 0,
                width: '100vw',
                height: '100dvh',
                maxWidth: 'none',
                maxHeight: 'none',
                margin: 0,
              }
            : panel
              ? {
                  position: 'fixed',
                  left: panel.left,
                  top: panel.top,
                  width: panel.width,
                  height: panel.height,
                  maxWidth: 'none',
                  maxHeight: 'none',
                  margin: 0,
                }
              : undefined
        }
      >
        {RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            data-testid={`resize-handle-${edge}`}
            onPointerDown={startResize(edge)}
            className={RESIZE_HANDLE_CLASS[edge]}
          />
        ))}
        <button
          type="button"
          data-testid="modal-maximize-toggle"
          aria-label={maximized ? 'Restore window size' : 'Maximize window'}
          onClick={toggleMaximize}
          className="absolute top-2.5 right-10 z-20 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-slate-300"
        >
          {maximized ? <Minimize2 aria-hidden className="h-4 w-4" /> : <Maximize2 aria-hidden className="h-4 w-4" />}
        </button>
        <ModalHeader
          data-testid="search-modal-header"
          onDoubleClick={(event) => {
            // Double-clicking the header toggles maximize (window convention) —
            // but never when the double-click was selecting text in a control.
            if ((event.target as HTMLElement).closest('input, button, textarea')) return;
            toggleMaximize();
          }}
          className="flex flex-col gap-3 border-b border-slate-200 pb-4 dark:border-zinc-700"
        >
          <Input
            ref={inputRef}
            autoFocus
            placeholder="Search Atlas documents..."
            value={query}
            onChange={(event) => replaceQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            startContent={<Search className="h-4 w-4 text-slate-400" />}
            endContent={
              queryRewriteEnabled ? (
                <button
                  type="button"
                  onClick={() => void ask()}
                  disabled={!canAsk}
                  aria-label="Ask Atlas to rewrite query"
                  aria-busy={rewriteStatus === 'loading'}
                  title={
                    askQueryLength > MAX_QUERY_REWRITE_LENGTH
                      ? `Ask supports up to ${MAX_QUERY_REWRITE_LENGTH} characters`
                      : undefined
                  }
                  className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rewriteStatus === 'loading' ? (
                    <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles aria-hidden className="h-3.5 w-3.5" />
                  )}
                  Ask
                </button>
              ) : undefined
            }
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={rows.length > 0 ? optionId(selectedIndex) : undefined}
            classNames={{ input: 'text-lg', inputWrapper: 'h-12' }}
          />

          {suggestions && (
            <div
              data-testid="operator-suggestions"
              className="max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {suggestions.self && (
                <button
                  type="button"
                  data-testid="suggestion-self"
                  onClick={() => {
                    replaceQuery(query.replace(/(in|type):[^\s"']*$/i, () => `in:${suggestions.self!.doc_no} `));
                    inputRef.current?.focus();
                  }}
                  className="block w-full truncate rounded px-1 py-0.5 text-left font-medium hover:bg-slate-100 dark:hover:bg-zinc-800"
                >
                  <span className="font-mono text-[10px] text-slate-400">{suggestions.self.doc_no} </span>
                  {suggestions.self.name || suggestions.self.doc_no}
                  <span className="text-slate-400"> — this whole section (Enter)</span>
                </button>
              )}
              {suggestions.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    const completion =
                      option.descend && suggestions.key === 'in'
                        ? `in:${option.value}`
                        : `${suggestions.key}:${option.value} `;
                    replaceQuery(query.replace(/(in|type|title):[^\s"']*$/i, () => completion));
                    inputRef.current?.focus();
                  }}
                  className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-slate-100 dark:hover:bg-zinc-800"
                >
                  {option.doc && <span className="font-mono text-[10px] text-slate-400">{option.value} </span>}
                  {option.label}
                  {option.count !== undefined && <span className="text-slate-400"> ({option.count})</span>}
                  {option.descend && suggestions.key === 'in' && <span className="text-slate-400"> ▸</span>}
                </button>
              ))}
            </div>
          )}

          {appliedRewrite && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100"
            >
              <span>
                Searching for: <span className="font-medium">{appliedRewrite.searchQuery}</span>
              </span>
              <button
                type="button"
                onClick={searchMyWords}
                className="font-medium underline decoration-blue-400 underline-offset-2 hover:text-blue-700 dark:hover:text-blue-200"
              >
                Search my words instead
              </button>
            </div>
          )}

          {rewriteError && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
            >
              {rewriteError}
            </p>
          )}

          {/* SEARCH-80: the mode is auto-detected only — this line reports it,
              amber when something is reduced or off, plain when everything runs. */}
          <div
            data-testid="search-mode-status"
            className={`rounded-md px-3 py-2 text-xs ${
              denseStatus === 'unavailable' || searchMode === 'low-memory'
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200'
                : 'bg-slate-50 text-slate-600 dark:bg-zinc-800/70 dark:text-slate-300'
            }`}
          >
            {denseStatus === 'unavailable'
              ? 'Similarity search is unavailable right now — showing keyword results only.'
              : searchMode === 'low-memory'
                ? 'Low-memory mode is on for this device: similarity results load from the server and need a connection.'
                : 'Full search mode — all features run on this device.'}
            {denseStatus === 'loading' && (
              <span role="status" className="sr-only">
                Improving search results
              </span>
            )}
            {denseStatus === 'unavailable' && (
              <span role="status" className="sr-only">
                Similarity search unavailable; keyword results are shown
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedTypes([])}
              aria-pressed={selectedTypes.length === 0}
              className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                selectedTypes.length === 0
                  ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                  : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-slate-300'
              }`}
            >
              All
            </button>
            {types.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                aria-label={`Filter by ${type}`}
                aria-pressed={selectedTypes.includes(type)}
                className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${typeColor(type)} ${
                  selectedTypes.includes(type) ? 'ring-2 ring-blue-400' : 'opacity-70'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* SEARCH-34 Tools row: discoverable filters, operator pills, cheatsheet.
              Inline panels rather than portal popovers on purpose: the modal marks the
              outside world aria-hidden, so portaled popover content is invisible to
              assistive technology; rendering inside the modal keeps it accessible. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="relative">
              <button
                type="button"
                data-testid="search-tools-trigger"
                aria-label="Search tools"
                aria-expanded={openTool === 'help'}
                onClick={() => setOpenTool((current) => (current === 'help' ? null : 'help'))}
                className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-zinc-800 dark:text-slate-300"
              >
                Search tools &#9662;
              </button>
              {openTool === 'help' && (
                <div className="absolute top-full left-0 z-30 mt-1 max-h-96 w-96 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 text-left text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <SearchToolsMenu onPick={applyTool} />
                </div>
              )}
            </span>
            {parsed.operators.map((operator, index) => {
              const unknown = operator.key === 'type' && unknownTypes.includes(operator.value);
              return (
                <button
                  key={`${operator.raw}-${index}`}
                  type="button"
                  data-testid={unknown ? 'operator-pill-unknown' : 'operator-pill'}
                  onClick={() => replaceQuery(query.replace(operator.raw, ' ').replace(/\s+/g, ' ').trim())}
                  title={
                    unknown
                      ? `No such node type — valid types are the chips above (e.g. Core, Article, Annotation)`
                      : 'Remove this filter'
                  }
                  className={
                    unknown
                      ? 'rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                      : 'rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                  }
                >
                  {operatorLabel(operator)} {unknown ? '(unknown type) ' : ''}&#10005;
                </button>
              );
            })}
          </div>

          {(availableScopes.length > 0 || selectedScopes.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-400 dark:text-slate-500">In:</span>
              {[...new Set([...selectedScopes, ...availableScopes])].map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => toggleScope(scope)}
                  aria-label={`Filter by scope ${scope}`}
                  aria-pressed={selectedScopes.includes(scope)}
                  className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                    selectedScopes.includes(scope)
                      ? 'bg-blue-600 text-white dark:bg-blue-500'
                      : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-slate-300'
                  }`}
                >
                  {scope}
                </button>
              ))}
            </div>
          )}
        </ModalHeader>

        <ModalBody className="py-4">
          {isIndexing && <p className="py-12 text-center text-slate-500 dark:text-slate-400">Indexing…</p>}

          {!hasQuery && (
            <div className="py-12 text-center text-slate-500 dark:text-slate-400">
              {recents.length > 0 && (
                <div className="mb-8">
                  <p className="mb-2 text-sm font-medium text-slate-600 dark:text-slate-300">Recent searches</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {recents.map((recent) => (
                      <button
                        key={recent}
                        type="button"
                        onClick={() => setQuery(recent)}
                        aria-label={`Search again for ${recent}`}
                        className="rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-blue-100 dark:bg-zinc-800 dark:text-slate-200 dark:hover:bg-blue-950"
                      >
                        {recent}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Search className="mx-auto mb-3 h-12 w-12 text-slate-300" />
              <p>
                {acronymChoices
                  ? `“${debouncedQuery.trim()}” is short for more than one thing — pick one:`
                  : isTooShort
                    ? `Keep typing — at least ${MIN_QUERY_LENGTH} characters are needed to search`
                    : 'Start typing to search across all Atlas documents'}
              </p>
              {acronymChoices && (
                <div data-testid="acronym-choice" className="mt-3 flex flex-wrap justify-center gap-2">
                  {acronymChoices.phrases.map((phrase) => (
                    <button
                      key={phrase}
                      type="button"
                      data-testid="acronym-choice-chip"
                      onClick={() => setQuery(phrase)}
                      className="rounded-full border border-indigo-300 px-3 py-1 text-sm font-medium text-indigo-900 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-100 dark:hover:bg-indigo-900"
                    >
                      {phrase}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">
                Search by document number, title, or content
              </p>
            </div>
          )}

          {hasQuery && ready && results.length === 0 && weakHits.length === 0 && (
            <div className="py-12 text-center text-slate-500 dark:text-slate-400">
              {isStopWordOnlyQuery(debouncedQuery) ? (
                <p>Only common words so far — try a more specific term</p>
              ) : (
                <p>No documents found for &quot;{debouncedQuery}&quot;</p>
              )}
              {selectedTypes.length > 0 && (
                <>
                  <p className="mt-1 text-sm">Type filters may be narrowing your results.</p>
                  <button
                    type="button"
                    onClick={() => setSelectedTypes([])}
                    aria-label="Clear filters"
                    className="mt-3 rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-blue-100 dark:bg-zinc-800 dark:text-slate-200"
                  >
                    Clear filters
                  </button>
                </>
              )}
            </div>
          )}

          {hasQuery && ready && (results.length > 0 || weakHits.length > 0) && (
            <div ref={listRef} className="space-y-1">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {uuidJumpDoc
                    ? 'Jumped to the document with this UUID'
                    : sections
                      ? // SEARCH-68: no summary in the sectioned view —
                        // the section headers and jump bar already carry the counts,
                        // and any sentence here just restates them wrong.
                        ''
                      : total > results.length
                        ? `Showing top ${results.length} of ${total} results`
                        : `${total} result${total === 1 ? '' : 's'}`}
                </p>
                {answersEnabled && (
                  <button
                    type="button"
                    onClick={requestAnswer}
                    disabled={currentAnswer?.state === 'loading'}
                    aria-label="Answer from these results"
                    aria-busy={currentAnswer?.state === 'loading'}
                    className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:text-slate-200 dark:hover:bg-zinc-700"
                  >
                    {currentAnswer?.state === 'loading' ? (
                      <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles aria-hidden className="h-3.5 w-3.5" />
                    )}
                    Answer from these results
                  </button>
                )}
              </div>

              {currentAnswer && currentAnswer.state !== 'loading' && (
                <div
                  data-testid="answer-panel"
                  role="status"
                  aria-live="polite"
                  className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {currentAnswer.state === 'error' && (
                    <p className="text-slate-600 dark:text-slate-300">{currentAnswer.message}</p>
                  )}
                  {currentAnswer.state === 'done' && currentAnswer.response.kind === 'abstained' && (
                    <p className="text-slate-600 dark:text-slate-300">
                      Not found in the retrieved documents: {currentAnswer.response.reason}
                    </p>
                  )}
                  {currentAnswer.state === 'done' && currentAnswer.response.kind === 'answer' && (
                    <div className="space-y-2">
                      {currentAnswer.response.claims.map((claim, index) => (
                        <div key={index}>
                          <p className="text-slate-800 dark:text-slate-100">{claim.text}</p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            “{claim.quote}”{' '}
                            <button
                              type="button"
                              onClick={() => navigateTo(claim.docNo)}
                              className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                            >
                              {claim.docNo}
                            </button>
                          </p>
                        </div>
                      ))}
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        AI-composed from the documents below; every quote is verified verbatim. Always check the cited
                        documents.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {noKeywordMatches && (
                <div
                  data-testid="no-exact-matches"
                  className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
                >
                  No exact matches for &quot;{trimmedQuery}&quot;.
                  {results.length > 0 ? ' Showing similar documents.' : ''}
                </div>
              )}

              {disambiguation && (
                <div
                  data-testid="entity-disambiguation"
                  role="status"
                  className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
                >
                  <span className="mr-1.5">
                    {disambiguation.entity.name} is an Atlas {disambiguation.entity.kind} — did you mean:
                  </span>
                  {disambiguation.chips.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      data-testid="entity-chip"
                      onClick={() => replaceQuery(chip.rewrite)}
                      className="mr-1.5 rounded-full border border-indigo-300 px-2 py-0.5 text-xs font-medium hover:bg-indigo-100 dark:border-indigo-700 dark:hover:bg-indigo-900"
                    >
                      {chip.label} ({chip.count})
                    </button>
                  ))}
                </div>
              )}

              {questionAnswer && hasQuery && (
                <button
                  type="button"
                  data-testid="question-answer"
                  onClick={() => navigateTo(questionAnswer.docNo)}
                  className="mb-2 block w-full rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-left text-sm text-emerald-900 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900"
                >
                  <span className="font-medium">{questionAnswer.text}</span>
                  {questionAnswer.preview && (
                    <span className="mt-1 block text-xs text-emerald-800 dark:text-emerald-200">
                      {questionAnswer.preview}
                    </span>
                  )}
                </button>
              )}

              {acronymEntry && hasQuery && (
                <div
                  data-testid="acronym-expansion-note"
                  role="status"
                  className="mb-2 text-xs text-slate-500 dark:text-slate-400"
                >
                  “{debouncedQuery.trim()}” is short for “{acronymEntry.phrases[0]}” — showing results for the full
                  phrase.
                </div>
              )}

              {graphInterpretations && (
                <div
                  data-testid="graph-interpretations"
                  role="status"
                  className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
                >
                  <span className="mr-1.5">Suggested related queries:</span>
                  {graphInterpretations.map((chip) => (
                    <button
                      key={`${chip.kind}:${chip.rewrite}`}
                      type="button"
                      data-testid="graph-interpretation-chip"
                      onClick={() => replaceQuery(chip.rewrite)}
                      className="mr-1.5 rounded-full border border-indigo-300 px-2 py-0.5 text-xs font-medium hover:bg-indigo-100 dark:border-indigo-700 dark:hover:bg-indigo-900"
                    >
                      {chip.label} ({chip.count})
                    </button>
                  ))}
                </div>
              )}

              {abbreviation && (
                <div
                  data-testid="atlas-abbreviation-notice"
                  role="status"
                  className="mb-2 rounded-lg border border-teal-200 bg-teal-50 p-2 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-100"
                >
                  Abbreviation applied: “{abbreviation.acronym.toUpperCase()}” → “{abbreviation.phrase}”. Matching
                  documents appear below the literal results.
                </div>
              )}

              {vocabulary && (
                <div
                  data-testid="atlas-vocabulary-notice"
                  role="status"
                  className="mb-2 rounded-lg border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
                >
                  Atlas vocabulary result included:{' '}
                  {vocabulary.replacements
                    .map(({ readerTerm, atlasTerm }) => `“${readerTerm}” → “${atlasTerm}”`)
                    .join(', ')}
                  .
                </div>
              )}

              {sections && sections.length > 1 && (
                <div
                  data-testid="section-jump-bar"
                  className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-1 rounded-md bg-white/95 px-1 py-1.5 backdrop-blur dark:bg-zinc-900/95"
                >
                  {sections.map((section) => (
                    <button
                      key={section.category}
                      type="button"
                      data-testid={`section-jump-${section.category}`}
                      onClick={() =>
                        document
                          .getElementById(`${listboxId}-section-${section.category}`)
                          ?.scrollIntoView({ block: 'start' })
                      }
                      className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200 dark:bg-zinc-800 dark:text-slate-300 dark:hover:bg-zinc-700"
                    >
                      {SECTION_LABEL[section.category]} ({section.total})
                    </button>
                  ))}
                </div>
              )}

              <div role="listbox" id={listboxId} aria-label="Search results">
                {(sections ?? [null]).map((section) => {
                  const sectionRows = section ? section.rows : rows;
                  const indexOffset = section ? section.startIndex : 0;
                  // SEARCH-74 follow-up (the "star grove" case): the header ALWAYS shows when
                  // categories are known — for a single-category list the label IS the
                  // information ("Partial matches (34)" says nothing exactly matched).
                  const showHeader = section !== null;
                  const headerId = section ? `${listboxId}-section-${section.category}` : undefined;
                  return (
                    <div
                      key={section ? section.category : 'flat'}
                      role={showHeader ? 'group' : undefined}
                      aria-labelledby={showHeader ? headerId : undefined}
                    >
                      {showHeader && section && (
                        <div
                          id={headerId}
                          data-testid={`section-header-${section.category}`}
                          onClick={() => toggleCollapsed(section.category)}
                          className="cursor-pointer scroll-mt-10 px-1 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase select-none hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                        >
                          <span aria-hidden className="mr-1 inline-block w-3">
                            {collapsedCategories.includes(section.category) ? '▸' : '▾'}
                          </span>
                          {SECTION_LABEL[section.category]} ({section.total})
                        </div>
                      )}
                      {sectionRows.map((row, rowOffset) => renderResultRow(row, indexOffset + rowOffset))}
                      {section && section.pageable && section.rows.length > 0 && (
                        <button
                          type="button"
                          data-testid={`section-show-all-${section.category}`}
                          onClick={() => revealSection(section.category)}
                          className="mt-1 block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {section.revealed
                            ? 'Show fewer'
                            : `Show all ${section.total - section.weakCount - section.belowBarCount} ${SECTION_LABEL[
                                section.category
                              ].toLowerCase()}`}
                        </button>
                      )}
                      {section && section.belowBarCount > 0 && (
                        <button
                          type="button"
                          data-testid={`section-quality-toggle-${section.category}`}
                          onClick={() => toggleQuality(section.category)}
                          className="mt-2 block text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
                        >
                          {qualityRevealed.includes(section.category)
                            ? section.category === 'related'
                              ? 'hide weaker connections'
                              : 'hide weaker matches'
                            : `${section.belowBarCount} weaker ${
                                section.category === 'related'
                                  ? `connection${section.belowBarCount === 1 ? '' : 's'}`
                                  : `match${section.belowBarCount === 1 ? '' : 'es'}`
                              } hidden — show ${section.belowBarCount === 1 ? 'it' : 'them'}`}
                        </button>
                      )}
                      {section && section.weakCount > 0 && (
                        <button
                          type="button"
                          data-testid="weak-matches-toggle"
                          onClick={toggleWeak}
                          className="mt-2 block text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
                        >
                          {showWeak
                            ? 'hide weak matches'
                            : `${section.weakCount} weak match${section.weakCount === 1 ? '' : 'es'} hidden — show ${
                                section.weakCount === 1 ? 'it' : 'them'
                              }`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {!sections && weakHits.length > 0 && (
                <button
                  type="button"
                  data-testid="weak-matches-toggle"
                  onClick={toggleWeak}
                  className="mt-2 block text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
                >
                  {showWeak
                    ? 'hide weak matches'
                    : `${weakHits.length} weak match${weakHits.length === 1 ? '' : 'es'} hidden — show ${
                        weakHits.length === 1 ? 'it' : 'them'
                      }`}
                </button>
              )}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
