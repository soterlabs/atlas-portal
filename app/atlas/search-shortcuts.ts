/**
 * Search-open keyboard shortcuts (SEARCH-33): CMD/Ctrl+K — the palette convention —
 * and "/" outside text inputs. Ctrl/Cmd+F is deliberately NOT handled: intercepting
 * it shadowed the browser's find, so readers could not search within the visible
 * results. A pure factory so the behavior is unit-testable without mounting the page.
 */
export function createSearchShortcutHandler(onOpen: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault();
      onOpen();
      return;
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);
      if (!typing) {
        event.preventDefault();
        onOpen();
      }
    }
  };
}
