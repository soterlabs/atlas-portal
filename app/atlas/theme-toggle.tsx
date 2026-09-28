'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

const noopSubscribe = () => () => {};
/** false during SSR and hydration, true on every client render after that. */
function useHydrated() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Theme toggle that flips between light and dark.
 *
 * On the client, next-themes resolves the theme synchronously from
 * localStorage / prefers-color-scheme, so `resolvedTheme` can already be
 * 'dark' during hydration while the server rendered with it undefined.
 * To keep SSR markup identical to the first client render we gate the icon on
 * a `mounted` flag (via useSyncExternalStore, so it is false during hydration) and render a
 * neutral placeholder until then.
 */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHydrated();

  const isDark = mounted && resolvedTheme === 'dark';

  const toggle = () => {
    if (mounted) setTheme(isDark ? 'light' : 'dark');
  };

  return (
    <button
      type="button"
      aria-label={mounted ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Toggle theme'}
      onClick={toggle}
      className="hover:bg-default-100 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
    >
      {!mounted ? (
        <span className="h-4 w-4" aria-hidden />
      ) : isDark ? (
        <Sun size={16} className="text-default-500" />
      ) : (
        <Moon size={16} className="text-default-500" />
      )}
      <span>{mounted ? (isDark ? 'Light mode' : 'Dark mode') : 'Theme'}</span>
    </button>
  );
}
