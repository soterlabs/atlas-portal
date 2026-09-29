import { describe, expect, it, vi } from 'vitest';
import { createSearchShortcutHandler } from '../search-shortcuts';

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init });
}

describe('createSearchShortcutHandler (SEARCH-33)', () => {
  it('opens on Ctrl/Cmd+K and consumes the event', () => {
    const onOpen = vi.fn();
    const handler = createSearchShortcutHandler(onOpen);
    const ctrlK = press('k', { ctrlKey: true });
    handler(ctrlK);
    const cmdK = press('k', { metaKey: true });
    handler(cmdK);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(ctrlK.defaultPrevented).toBe(true);
    expect(cmdK.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl/Cmd+F to the browser — find-in-page works again', () => {
    const onOpen = vi.fn();
    const handler = createSearchShortcutHandler(onOpen);
    const ctrlF = press('f', { ctrlKey: true });
    handler(ctrlF);
    expect(onOpen).not.toHaveBeenCalled();
    expect(ctrlF.defaultPrevented).toBe(false);
  });

  it('opens on "/" outside text inputs, but never while typing', () => {
    const onOpen = vi.fn();
    const handler = createSearchShortcutHandler(onOpen);
    window.addEventListener('keydown', handler);

    document.body.dispatchEvent(press('/'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(press('/'));
    expect(onOpen).toHaveBeenCalledTimes(1); // unchanged — the reader was typing

    window.removeEventListener('keydown', handler);
    input.remove();
  });
});
