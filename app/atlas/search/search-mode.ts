/**
 * SEARCH-20 mode selection: deployment default and device hint.
 *
 * SEARCH-80 removed the user override (toggle + stored preference): the mode
 * is the deployment pin when set, else device detection, and the UI only
 * reports the outcome — an amber warning in low-memory mode, "full" otherwise.
 */

export type SearchMode = 'local' | 'low-memory';

type ConfiguredSearchMode = SearchMode | 'auto';

/**
 * `NEXT_PUBLIC_SEARCH_MODE` is the explicit SEARCH-20 switch. Preserve the SEARCH-19
 * `NEXT_PUBLIC_SEARCH_EMBEDDER=server` entry point as a backwards-compatible default.
 */
export function configuredSearchMode(): ConfiguredSearchMode {
  const configured = process.env.NEXT_PUBLIC_SEARCH_MODE;
  if (configured === 'auto' || configured === 'local' || configured === 'low-memory') return configured;
  return process.env.NEXT_PUBLIC_SEARCH_EMBEDDER === 'server' ? 'low-memory' : 'auto';
}

/** Device detection: small reported memory, data-saver, or a phone-width viewport. */
export function deviceSearchMode(): SearchMode {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'local';
  const hints = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  const narrowViewport = window.matchMedia?.('(max-width: 767px)').matches ?? false;
  return hints.connection?.saveData || (hints.deviceMemory !== undefined && hints.deviceMemory <= 4) || narrowViewport
    ? 'low-memory'
    : 'local';
}

export function defaultSearchMode(): SearchMode {
  const configured = configuredSearchMode();
  return configured === 'auto' ? deviceSearchMode() : configured;
}
