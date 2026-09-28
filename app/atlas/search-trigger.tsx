'use client';

import { useState } from 'react';
import { Input } from '@heroui/react';
import { Search } from 'lucide-react';

interface SearchTriggerProps {
  onOpen: () => void;
}

export default function SearchTrigger({ onOpen }: SearchTriggerProps) {
  // Detect platform for keyboard shortcut display (lazy initialization)
  const [isMac] = useState(() => {
    if (typeof window === 'undefined') return false;
    return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  });

  return (
    <div onClick={onOpen} className="cursor-pointer">
      <Input
        placeholder="Search Atlas..."
        readOnly
        startContent={<Search className="h-4 w-4 text-slate-400" />}
        endContent={
          <kbd
            className="hidden rounded bg-slate-100 px-2 py-1 text-xs text-slate-500 sm:inline-block dark:bg-zinc-800 dark:text-slate-300"
            suppressHydrationWarning
          >
            {isMac ? '⌘' : 'Ctrl+'}K
          </kbd>
        }
        classNames={{
          inputWrapper:
            'cursor-pointer transition-all duration-200 border border-slate-200 hover:border-blue-400 bg-white hover:bg-blue-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
        }}
        aria-label="Open search dialog (CMD+K or Ctrl+K)"
      />
    </div>
  );
}
