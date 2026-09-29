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
 * Header-mounted theme toggle. Single icon button that flips light ↔ dark.
 *
 * On the client, next-themes resolves the theme synchronously from
 * localStorage / prefers-color-scheme, so `resolvedTheme` can already be
 * 'dark' during hydration while the server rendered with it undefined.
 * To keep SSR markup identical to the first client render we gate the icon on
 * a `mounted` flag (via useSyncExternalStore, so it is false during hydration) and render a
 * neutral placeholder until then.
 */
export default function PortalThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHydrated();

  const isDark = mounted && resolvedTheme === 'dark';

  const toggle = () => {
    if (mounted) setTheme(isDark ? 'light' : 'dark');
  };

  const label = mounted ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Toggle theme';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={toggle}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-zinc-800"
    >
      {!mounted ? (
        <span className="h-4 w-4" aria-hidden />
      ) : isDark ? (
        <Sun size={16} aria-hidden />
      ) : (
        <Moon size={16} aria-hidden />
      )}
    </button>
  );
}
