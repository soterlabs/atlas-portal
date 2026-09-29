'use client';

import { useEffect, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { ExportAtlasTreeDocument } from '@/app/server/atlas/export/types';
import { type UuidMappings } from '@/app/server/atlas/load-uuid-mapping';
import ContentTree from './content-tree';
import MobileTopBar from './mobile-top-bar';
import { createSearchShortcutHandler } from './search-shortcuts';
import SearchModal from './search/search-modal';
import Sidebar from './sidebar';

interface AtlasPagePrerenderedProps {
  exportScopeTreesWithoutAgents: ExportAtlasTreeDocument[];
  uuidMappings: UuidMappings;
  queryRewriteEnabled: boolean;
  answersEnabled?: boolean;
}

export default function AtlasPagePrerendered({
  exportScopeTreesWithoutAgents,
  uuidMappings,
  queryRewriteEnabled,
  answersEnabled = false,
}: AtlasPagePrerenderedProps) {
  const [scopeTreesWithoutAgents] = useState(exportScopeTreesWithoutAgents);
  const { isOpen: isSearchOpen, onOpen: onSearchOpen, onClose: onSearchClose } = useDisclosure();

  // Search shortcuts (SEARCH-33): CMD/Ctrl+K and "/" — Ctrl/Cmd+F belongs to the
  // browser again. Behavior lives in createSearchShortcutHandler (unit-tested).
  useEffect(() => {
    const handleKeyDown = createSearchShortcutHandler(onSearchOpen);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSearchOpen]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-white dark:bg-zinc-900">
      <MobileTopBar scopeTrees={scopeTreesWithoutAgents} onSearchOpen={onSearchOpen} />
      <Sidebar scopeTrees={scopeTreesWithoutAgents} uuidMappings={uuidMappings} onSearchOpen={onSearchOpen} />
      <div className="min-w-0 pt-24 pb-24 sm:ml-80 sm:p-6 sm:pt-6 sm:pb-24">
        <ContentTree scopeTreesWithoutAgents={scopeTreesWithoutAgents} uuidMappings={uuidMappings} />
      </div>

      {/* Single SearchModal instance for the entire page */}
      <SearchModal
        scopeTrees={scopeTreesWithoutAgents}
        isOpen={isSearchOpen}
        onClose={onSearchClose}
        queryRewriteEnabled={queryRewriteEnabled}
        answersEnabled={answersEnabled}
      />
    </div>
  );
}
