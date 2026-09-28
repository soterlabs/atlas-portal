'use client';

import React, { useState } from 'react';
import { AtlasDocumentType } from '@/app/server/atlas/atlas-types';
import { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { typeColorMap } from '@/app/server/atlas/formatters/type-color-map';
import { markdownToHTML } from '@/app/server/markdown/markdown-to-html';
import { CustomHTML } from '../components/custom-html';
import { UuidMappings } from '../server/atlas/load-uuid-mapping';
import { LOCAL_STORAGE_CHANGED_EVENT, SHOW_UUIDS_STORAGE_KEY } from './constants';
import styles from './content-tree.module.css';
import { CopyToClipboardButton } from './copy-to-clipboard-button';
import { addExpandScopeListener } from './custom-events';
import { DetailsAccordionItem } from './details-accordion';
import { ExportTreeExtraData } from './export-tree-extra-data';
import { createPathLookupMap, createUuidToDocNoMap } from './tree-utils';
import TypeChip from './type-chip';

/**
 * Document types that are shown in the sidebar (immutable and primary docs).
 * Clicking these in the main panel will sync the sidebar to the same document.
 */
const IMMUTABLE_AND_PRIMARY_TYPES = new Set<AtlasDocumentType>([
  'Scope',
  'Article',
  'Section',
  'Core',
  'Type Specification',
  'Active Data Controller',
]);

/**
 * Updates the URL hash and dispatches a hashchange event to sync the sidebar.
 * Only triggers for immutable and primary document types that appear in the sidebar.
 * Only dispatches if the hash is actually changing to avoid interfering with accordion toggle.
 * Returns true if hashchange was dispatched (caller should stop propagation).
 */
function syncHashToSidebar(
  docNumber: string | undefined,
  uuid: string | undefined,
  docType: AtlasDocumentType | undefined,
): boolean {
  if (!docType || !IMMUTABLE_AND_PRIMARY_TYPES.has(docType)) return false;
  // Use UUID for the hash if available, falling back to doc number
  const hashValue = uuid || docNumber;
  if (!hashValue) return false;
  // Only update hash if it's actually different to avoid interfering with accordion toggle
  const currentHash = window.location.hash.slice(1);
  if (currentHash === hashValue) return false;
  const newUrl = `${window.location.pathname}${window.location.search}#${hashValue}`;
  window.history.pushState(null, '', newUrl);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true; // Hashchange dispatched, caller should stop propagation
}

interface RenderTreeNodeProps {
  node: ExportAtlasTreeDocument;
  depth?: number;
  isRootNode?: boolean;
  uuidMappings: UuidMappings;
  uuidToDocNoMap: Map<string, string>;
  isHighlighted: boolean;
  getIsHighlighted: (docNumber: string) => boolean;
  isExpanded: boolean;
  getIsExpanded: (uuid: string) => boolean;
  onToggleExpanded: (uuid: string) => void;
  showUUIDs: boolean;
}

/**
 * Supporting documents that can be attached to a node
 */
type SupportingDocsContainer = {
  annotations?: ExportAtlasTreeDocument[];
  tenets?: ExportAtlasTreeDocument[];
  scenarios?: ExportAtlasTreeDocument[];
  scenario_variations?: ExportAtlasTreeDocument[];
  active_data?: ExportAtlasTreeDocument[];
  needed_research?: ExportAtlasTreeDocument[];
};

/**
 * Immutable and primary documents that form the main document hierarchy
 */
type ImmutableDocsContainer = {
  scopes?: ExportAtlasTreeDocument[];
  articles?: ExportAtlasTreeDocument[];
  sections_and_primary_docs?: ExportAtlasTreeDocument[];
  agent_scope_database?: ExportAtlasTreeDocument[];
};

/**
 * Shared props for rendering functions
 */
interface RenderDocumentsSharedProps {
  depth: number;
  uuidMappings: UuidMappings;
  uuidToDocNoMap: Map<string, string>;
  getIsHighlighted: (docNumber: string) => boolean;
  getIsExpanded: (uuid: string) => boolean;
  onToggleExpanded: (uuid: string) => void;
  showUUIDs: boolean;
}

interface RenderSupportingDocumentListProps extends RenderDocumentsSharedProps {
  label: string;
  documentType: AtlasDocumentType;
  documents: ExportAtlasTreeDocument[];
}

function renderSupportingDocumentListInSameType({
  label,
  documentType,
  documents,
  depth,
  uuidMappings,
  uuidToDocNoMap,
  getIsHighlighted,
  getIsExpanded,
  onToggleExpanded,
  showUUIDs,
}: RenderSupportingDocumentListProps) {
  const colorStyles = typeColorMap[documentType] || 'bg-gray-100 text-gray-800 dark:bg-zinc-800 dark:text-zinc-200';

  return (
    <div className="mt-2 ml-0">
      <span className={`${colorStyles} rounded px-2 py-1 text-sm`}>{label}</span>
      <ul className={styles.supportingDocsList}>
        {documents.map((child, idx) => {
          const childNotionId = child.uuid ? uuidMappings.atlasUUIDsToNotionPageIds.get(child.uuid) : null;
          const key = childNotionId || `doc-${idx}`;
          return (
            <TreeNode
              key={key}
              node={child}
              depth={depth + 1}
              isRootNode={false}
              uuidMappings={uuidMappings}
              uuidToDocNoMap={uuidToDocNoMap}
              isHighlighted={getIsHighlighted(child.doc_no || '')}
              getIsHighlighted={getIsHighlighted}
              isExpanded={getIsExpanded(child.uuid || '')}
              getIsExpanded={getIsExpanded}
              onToggleExpanded={onToggleExpanded}
              showUUIDs={showUUIDs}
            />
          );
        })}
      </ul>
    </div>
  );
}

interface RenderSupportingDocumentsProps extends RenderDocumentsSharedProps {
  node: ExportAtlasTreeDocument;
}

function renderSupportingDocuments({
  node,
  depth,
  uuidMappings,
  uuidToDocNoMap,
  getIsHighlighted,
  getIsExpanded,
  onToggleExpanded,
  showUUIDs,
}: RenderSupportingDocumentsProps): React.ReactElement | null {
  const nodeId = node.uuid || '';

  // Get supporting documents from child collections
  const docWithSupporting = node as ExportAtlasTreeDocument & SupportingDocsContainer;

  const supportingDocumentLabels = [
    {
      label: 'Needed Research',
      documentType: 'Needed Research' as const,
      documents: docWithSupporting.needed_research || [],
    },
    { label: 'Annotations', documentType: 'Annotation' as const, documents: docWithSupporting.annotations || [] },
    { label: 'Tenets', documentType: 'Action Tenet' as const, documents: docWithSupporting.tenets || [] },
    { label: 'Scenarios', documentType: 'Scenario' as const, documents: docWithSupporting.scenarios || [] },
    {
      label: 'Scenario Variations',
      documentType: 'Scenario Variation' as const,
      documents: docWithSupporting.scenario_variations || [],
    },
    { label: 'Active Data', documentType: 'Active Data' as const, documents: docWithSupporting.active_data || [] },
  ].filter((entry) => entry.documents.length > 0);

  if (supportingDocumentLabels.length === 0) {
    return null;
  }

  return (
    <div className={styles.supportingDocsContainer}>
      <span className={styles.supportingDocsLabel}>Supporting Documents</span>

      {supportingDocumentLabels.map(({ label, documentType, documents }) => (
        <div
          key={`${
            (node.uuid && uuidMappings.atlasUUIDsToNotionPageIds.get(node.uuid)) || node.doc_no || nodeId
          }-${label}`}
        >
          {renderSupportingDocumentListInSameType({
            label,
            documentType,
            documents,
            depth,
            uuidMappings,
            uuidToDocNoMap,
            getIsHighlighted,
            getIsExpanded,
            onToggleExpanded,
            showUUIDs,
          })}
        </div>
      ))}
    </div>
  );
}

/**
 *
 */
function TreeNode({
  node,
  depth = 0,
  isRootNode = false,
  uuidMappings,
  uuidToDocNoMap,
  isHighlighted,
  getIsHighlighted,
  isExpanded,
  getIsExpanded,
  onToggleExpanded,
  showUUIDs,
}: RenderTreeNodeProps): React.ReactElement {
  // Get node identifiers and metadata based on type
  const nodeId = node.uuid || '';
  const docNumber = node.doc_no;
  const docName = node.name;
  const docType = node.type;

  // Format content based on type, converting UUID links to document number anchors
  const formattedContent = markdownToHTML(node.content, uuidToDocNoMap);

  // Get immutable and primary document children based on node type
  const docWithImmutable = node as ExportAtlasTreeDocument & ImmutableDocsContainer;

  const immutableAndPrimaryDocumentPages: ExportAtlasTreeDocument[] = [
    ...(docWithImmutable.scopes || []),
    ...(docWithImmutable.articles || []),
    ...(docWithImmutable.sections_and_primary_docs || []),
    ...(docWithImmutable.agent_scope_database || []),
  ];

  if (depth > 50) {
    throw new Error('Maximum tree depth exceeded, possible circular reference');
  }

  // Node's body content (the node's own content)
  const nodeBodyContent = (
    <>
      <div className={`${styles.nodeContent} ${isRootNode ? styles.nodeContentRoot : ''}`}>
        <CustomHTML html={formattedContent} />
      </div>

      <ExportTreeExtraData node={node} className={styles.nodeContent} uuidToDocNoMap={uuidToDocNoMap} />

      {showUUIDs && (
        <div className={`${styles.notionLink} ${isRootNode ? styles.notionLinkRoot : ''}`}>
          <span>{`Atlas UUID: ${node.uuid}`}</span>
        </div>
      )}
    </>
  );

  // Children content (immutable/primary and supporting documents)
  const childrenContent = (
    <>
      {immutableAndPrimaryDocumentPages.length > 0 && (
        <ul className="mt-1 border-l border-gray-200 sm:pl-4 dark:border-zinc-700">
          {immutableAndPrimaryDocumentPages.map((child, idx) => {
            const childNotionId = child.uuid ? uuidMappings.atlasUUIDsToNotionPageIds.get(child.uuid) : null;
            const key = childNotionId || `child-${idx}`;
            return (
              <TreeNode
                key={key}
                node={child}
                depth={depth + 1}
                isRootNode={false}
                uuidMappings={uuidMappings}
                uuidToDocNoMap={uuidToDocNoMap}
                isHighlighted={getIsHighlighted(child.doc_no || '')}
                getIsHighlighted={getIsHighlighted}
                isExpanded={getIsExpanded(child.uuid || '')}
                getIsExpanded={getIsExpanded}
                onToggleExpanded={onToggleExpanded}
                showUUIDs={showUUIDs}
              />
            );
          })}
        </ul>
      )}

      {renderSupportingDocuments({
        node,
        depth,
        uuidMappings,
        uuidToDocNoMap,
        getIsHighlighted,
        getIsExpanded,
        onToggleExpanded,
        showUUIDs,
      })}
    </>
  );

  // Prefer Notion page ID for stable React keys; fallback to doc number or UUID-derived string
  const notionKey = (node.uuid && uuidMappings.atlasUUIDsToNotionPageIds.get(node.uuid)) || null;

  // Root nodes are already wrapped in a DetailsAccordionItem by ContentTree
  // Only render the body content and children without another accordion wrapper
  if (isRootNode) {
    return (
      <div className={styles.rootTitle} key={notionKey || docNumber || `node-${nodeId || 'unknown'}`}>
        {nodeBodyContent}
        {childrenContent}
      </div>
    );
  }

  // Non-root nodes are collapsible - render with DetailsAccordionItem
  const nodeContent = (
    <DetailsAccordionItem
      id={nodeId}
      isExpanded={isExpanded}
      onToggle={() => onToggleExpanded(nodeId)}
      isHighlighted={isHighlighted}
      ariaLabel={`${docNumber} - ${docName}`}
      dataDocId={docNumber}
      title={
        <div
          className={`${styles.nodeTitle} flex items-center gap-0.5`}
          onClick={() => {
            // Sync sidebar when clicking on immutable/primary docs
            syncHashToSidebar(docNumber, nodeId, docType);
          }}
        >
          <span
            className="cursor-text rounded px-1 hover:bg-slate-200 dark:hover:bg-zinc-800"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {docNumber} - {docName}
          </span>
          <CopyToClipboardButton
            text={
              typeof window !== 'undefined'
                ? `${window.location.origin}${window.location.pathname}#${nodeId || docNumber}`
                : `#${nodeId || docNumber}`
            }
          />
          <TypeChip type={docType} />
        </div>
      }
    >
      {nodeBodyContent}
      {childrenContent}
    </DetailsAccordionItem>
  );

  return (
    <li key={notionKey || docNumber || `node-${nodeId || 'unknown'}`} className={styles.listItem}>
      {nodeContent}
    </li>
  );
}

export default function ContentTree({
  scopeTreesWithoutAgents,
  uuidMappings,
}: {
  scopeTreesWithoutAgents: ExportAtlasTreeDocument[];
  uuidMappings: UuidMappings;
}) {
  // State to control which accordion items are expanded
  // Keys are UUIDs for all document types
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    return new Set([]);
  });

  // State to track the currently highlighted document from URL hash
  const [highlightedDocNumber, setHighlightedDocNumber] = useState<string | null>(null);

  // State to control whether UUIDs are shown (read from localStorage)
  const [showUUIDs, setShowUUIDs] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const stored = localStorage.getItem(SHOW_UUIDS_STORAGE_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  // Build path lookup map once on mount for O(1) lookups (memoized)
  const pathLookupMap = React.useMemo(() => {
    return createPathLookupMap(scopeTreesWithoutAgents);
  }, [scopeTreesWithoutAgents]);

  // Build UUID to document number map once on mount for converting internal links (memoized)
  const uuidToDocNoMap = React.useMemo(() => {
    return createUuidToDocNoMap(scopeTreesWithoutAgents);
  }, [scopeTreesWithoutAgents]);

  // Build reverse map (doc number → UUID) for generating stable UUID-based URLs
  const docNoToUuidMap = React.useMemo(() => {
    const map = new Map<string, string>();
    uuidToDocNoMap.forEach((docNo, uuid) => map.set(docNo, uuid));
    return map;
  }, [uuidToDocNoMap]);

  // Listen for localStorage changes to update showUUIDs without page reload
  React.useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === SHOW_UUIDS_STORAGE_KEY) {
        setShowUUIDs(e.newValue === 'true');
      }
    };

    // Listen for storage events (fired when localStorage changes in other tabs/windows)
    window.addEventListener('storage', handleStorageChange);

    // Also listen for custom-emitted events for same-window updates
    const handleCustomStorageChange = () => {
      try {
        const stored = localStorage.getItem(SHOW_UUIDS_STORAGE_KEY);
        setShowUUIDs(stored === 'true');
      } catch {
        // Ignore errors
      }
    };

    // Listen for custom event fired when localStorage changes in same window
    window.addEventListener(LOCAL_STORAGE_CHANGED_EVENT, handleCustomStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGED_EVENT, handleCustomStorageChange);
    };
  }, []);

  // Listen for hash changes to highlight the target document and expand the path to it
  React.useEffect(() => {
    let scrollTimeout: NodeJS.Timeout | null = null;

    const updateHighlight = () => {
      let hash = window.location.hash.slice(1); // Remove the '#' prefix

      // If the hash looks like a UUID, resolve it to a document number for internal lookup
      // but keep the UUID in the URL for stable sharing
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (hash && uuidPattern.test(hash)) {
        const docNo = uuidToDocNoMap.get(hash);
        if (docNo) {
          hash = docNo;
        }
      }

      setHighlightedDocNumber(hash || null);

      if (hash) {
        // Look up the path using O(1) map lookup instead of O(n) tree traversal
        const path = pathLookupMap.get(hash);
        if (path && path.length > 0) {
          // Expand all nodes in the path (merge with existing expanded keys to preserve user interactions)
          setExpandedKeys((prev) => {
            const newSet = new Set(prev);
            path.forEach((uuid) => newSet.add(uuid));
            return newSet;
          });

          // Clear any pending scroll timeout to debounce rapid navigation
          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
          }

          // Use double requestAnimationFrame for scrolling:
          // First rAF: React commits the DOM changes (expanded accordions)
          // Second rAF: DOM is painted, now safe to scroll
          scrollTimeout = setTimeout(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // Use querySelector with data-doc-id instead of getElementById
                // This prevents browser's native hash navigation behavior
                // Escape special characters in CSS selector to prevent injection
                const escapedHash = CSS.escape(hash);
                const element = document.querySelector(`[data-doc-id="${escapedHash}"]`);
                if (element) {
                  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              });
            });
            scrollTimeout = null;
          }, 0);
        }
      }
    };

    // Set initial highlight
    updateHighlight();

    // Listen for hash changes
    window.addEventListener('hashchange', updateHighlight);
    return () => {
      window.removeEventListener('hashchange', updateHighlight);
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
    };
  }, [pathLookupMap, uuidToDocNoMap]);

  // Listen for expandScope custom events from sidebar
  React.useEffect(() => {
    let navigationTimeout: NodeJS.Timeout | null = null;

    const cleanup = addExpandScopeListener((event) => {
      const { targetDocID } = event.detail;

      // Clear any pending navigation timeout to debounce rapid clicks
      if (navigationTimeout) {
        clearTimeout(navigationTimeout);
        navigationTimeout = null;
      }

      // Look up the path using O(1) map lookup instead of O(n) tree traversal
      const path = pathLookupMap.get(targetDocID);
      if (path) {
        // Replace expanded keys with only the path to the target (focused navigation)
        setExpandedKeys(new Set(path));

        // Use requestAnimationFrame for immediate update on next paint
        // Since accordions have disableAnimation=true and nodes are memoized,
        // this is fast enough to feel instant while ensuring DOM updates
        navigationTimeout = setTimeout(() => {
          requestAnimationFrame(() => {
            // Use history.pushState to update hash without triggering browser's native scroll
            // This prevents double-scrolling (browser scroll + our custom scroll)
            // Prefer UUID for stable URLs, fall back to doc number
            const hashValue = docNoToUuidMap.get(targetDocID) || targetDocID;
            const newUrl = `${window.location.pathname}${window.location.search}#${hashValue}`;
            window.history.pushState(null, '', newUrl);
            // Manually trigger hashchange event for our listeners
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          });
          navigationTimeout = null;
        }, 0);
      }
    });

    return () => {
      cleanup();
      if (navigationTimeout) {
        clearTimeout(navigationTimeout);
      }
    };
  }, [pathLookupMap, docNoToUuidMap]);

  // Handler to toggle expansion of Article/Section nodes
  const handleToggleExpanded = React.useCallback((uuid: string) => {
    setExpandedKeys((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(uuid)) {
        newSet.delete(uuid);
      } else {
        newSet.add(uuid);
      }
      return newSet;
    });
  }, []);

  // Function to check if a node is expanded
  const getIsExpanded = React.useCallback(
    (uuid: string) => {
      return expandedKeys.has(uuid);
    },
    [expandedKeys],
  );

  // Function to check if a node is highlighted
  const getIsHighlighted = React.useCallback(
    (docNumber: string) => {
      // Don't match empty strings
      if (!docNumber || !highlightedDocNumber) {
        return false;
      }
      return highlightedDocNumber === docNumber;
    },
    [highlightedDocNumber],
  );

  if (scopeTreesWithoutAgents.length === 0) {
    return <div>No Scopes found in Atlas</div>;
  }

  return (
    <div className={styles.containerMain}>
      <div className="flex max-w-full flex-col space-y-6">
        {scopeTreesWithoutAgents.map((scopeTree, idx) => (
          <DetailsAccordionItem
            key={scopeTree.uuid || `scope-${idx}`}
            id={scopeTree.uuid || `scope-${idx}`}
            isExpanded={getIsExpanded(scopeTree.uuid || '')}
            onToggle={() => handleToggleExpanded(scopeTree.uuid || '')}
            isHighlighted={getIsHighlighted(scopeTree.doc_no || '')}
            ariaLabel={scopeTree.name || `Document ${scopeTree.uuid || 'unknown'}`}
            dataDocId={scopeTree.doc_no}
            isRoot={true}
            title={
              <div
                className={`${styles.accordionTitle} flex items-center gap-0.5 text-xl font-semibold text-gray-900 dark:text-gray-100`}
                onClick={() => {
                  // Sync sidebar when clicking on scope docs
                  syncHashToSidebar(scopeTree.doc_no, scopeTree.uuid || undefined, scopeTree.type);
                }}
              >
                <span
                  className="cursor-text rounded px-1 hover:bg-slate-200 dark:hover:bg-zinc-800"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {scopeTree.doc_no} - {scopeTree.name}
                </span>
                <CopyToClipboardButton
                  text={
                    typeof window !== 'undefined'
                      ? `${window.location.origin}${window.location.pathname}#${scopeTree.uuid || scopeTree.doc_no}`
                      : `#${scopeTree.uuid || scopeTree.doc_no}`
                  }
                />
                <TypeChip type={scopeTree.type} />
              </div>
            }
          >
            <TreeNode
              node={scopeTree}
              depth={0}
              isRootNode={true}
              uuidMappings={uuidMappings}
              uuidToDocNoMap={uuidToDocNoMap}
              isHighlighted={getIsHighlighted(scopeTree.doc_no || '')}
              getIsHighlighted={getIsHighlighted}
              isExpanded={getIsExpanded(scopeTree.uuid || '')}
              getIsExpanded={getIsExpanded}
              onToggleExpanded={handleToggleExpanded}
              showUUIDs={showUUIDs}
            />
          </DetailsAccordionItem>
        ))}
      </div>
    </div>
  );
}
