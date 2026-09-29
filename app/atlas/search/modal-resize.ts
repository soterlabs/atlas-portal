/**
 * Window-style resize math for the search modal (SEARCH-33, product decision:
 * "resize it just like a regular browser window by dragging the border"). Pure: the
 * modal wires pointer events to `resizePanel`; dragging an edge moves that edge while
 * the opposite edge stays anchored, clamped to sane bounds inside the viewport. On
 * viewports narrower than the modal minimum the viewport wins, so the close and
 * maximize controls always stay reachable (portrait phones).
 */

export interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const MODAL_MIN_WIDTH = 480;
export const MODAL_MIN_HEIGHT = 360;
/** Breathing room the panel always keeps from the viewport edges. */
export const MODAL_VIEWPORT_MARGIN = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The effective minimums: the modal minimum, or the viewport (minus margins) when that is smaller. */
function minimums(viewport: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(MODAL_MIN_WIDTH, Math.max(0, viewport.width - 2 * MODAL_VIEWPORT_MARGIN)),
    height: Math.min(MODAL_MIN_HEIGHT, Math.max(0, viewport.height - 2 * MODAL_VIEWPORT_MARGIN)),
  };
}

/**
 * The rect after dragging `edge` by (dx, dy) from `start`. The opposite edge is the
 * anchor: dragging `w` keeps the right edge fixed, dragging `n` keeps the bottom.
 */
export function resizePanel(
  start: PanelRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewport: { width: number; height: number },
): PanelRect {
  const maxWidth = viewport.width - 2 * MODAL_VIEWPORT_MARGIN;
  const maxHeight = viewport.height - 2 * MODAL_VIEWPORT_MARGIN;
  const min = minimums(viewport);
  const right = start.left + start.width;
  const bottom = start.top + start.height;

  let { left, top, width, height } = start;

  if (edge.includes('e')) width = clamp(start.width + dx, min.width, maxWidth);
  if (edge.includes('w')) {
    width = clamp(start.width - dx, min.width, maxWidth);
    left = right - width; // anchor the right edge
  }
  if (edge.includes('s')) height = clamp(start.height + dy, min.height, maxHeight);
  if (edge.includes('n')) {
    height = clamp(start.height - dy, min.height, maxHeight);
    top = bottom - height; // anchor the bottom edge
  }

  // Keep the whole panel inside the viewport margin.
  left = clamp(
    left,
    MODAL_VIEWPORT_MARGIN,
    Math.max(MODAL_VIEWPORT_MARGIN, viewport.width - MODAL_VIEWPORT_MARGIN - width),
  );
  top = clamp(
    top,
    MODAL_VIEWPORT_MARGIN,
    Math.max(MODAL_VIEWPORT_MARGIN, viewport.height - MODAL_VIEWPORT_MARGIN - height),
  );

  return { left, top, width, height };
}

/** A centered rect of the persisted (or default) size, clamped to the viewport. */
export function centeredPanel(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): PanelRect {
  const min = minimums(viewport);
  const width = clamp(size.width, min.width, viewport.width - 2 * MODAL_VIEWPORT_MARGIN);
  const height = clamp(size.height, min.height, viewport.height - 2 * MODAL_VIEWPORT_MARGIN);
  return {
    left: Math.max(MODAL_VIEWPORT_MARGIN, (viewport.width - width) / 2),
    top: Math.max(MODAL_VIEWPORT_MARGIN, (viewport.height - height) / 2),
    width,
    height,
  };
}

/**
 * SEARCH-67: the maximized rect — exactly the viewport, no margin and no minimum
 * (a minimum larger than the screen would push the controls off it). Used to seed a
 * drag that starts while maximized (the drag itself re-enters normal resize and
 * its clamps).
 */
export function maximizedPanel(viewport: { width: number; height: number }): PanelRect {
  return { left: 0, top: 0, width: viewport.width, height: viewport.height };
}
