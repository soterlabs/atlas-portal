import { describe, expect, it } from 'vitest';
import {
  MODAL_MIN_HEIGHT,
  MODAL_MIN_WIDTH,
  MODAL_VIEWPORT_MARGIN,
  centeredPanel,
  maximizedPanel,
  resizePanel,
} from '../modal-resize';

const viewport = { width: 1200, height: 800 };
const start = { left: 300, top: 100, width: 600, height: 500 };

describe('resizePanel', () => {
  it('dragging on a narrow viewport can never push the panel past the margin (bug 11)', () => {
    const phone = { width: 400, height: 700 };
    const narrow = centeredPanel({ width: 800, height: 600 }, phone);
    const next = resizePanel(narrow, 'e', 300, 0, phone);
    expect(next.left + next.width).toBeLessThanOrEqual(phone.width - MODAL_VIEWPORT_MARGIN);
    const shrunk = resizePanel(narrow, 'w', 200, 0, phone);
    expect(shrunk.width).toBeLessThanOrEqual(phone.width - 2 * MODAL_VIEWPORT_MARGIN);
  });

  it('grows eastward without moving the left edge', () => {
    const next = resizePanel(start, 'e', 80, 0, viewport);
    expect(next).toEqual({ ...start, width: 680 });
  });

  it('grows westward anchoring the right edge — the regular-window feel', () => {
    const next = resizePanel(start, 'w', -100, 0, viewport);
    expect(next.width).toBe(700);
    expect(next.left).toBe(200);
    expect(next.left + next.width).toBe(start.left + start.width); // right edge fixed
  });

  it('grows northward anchoring the bottom edge', () => {
    const next = resizePanel(start, 'n', 0, -60, viewport);
    expect(next.height).toBe(560);
    expect(next.top + next.height).toBe(start.top + start.height);
  });

  it('combines both axes on a corner drag', () => {
    const next = resizePanel(start, 'se', 50, 40, viewport);
    expect(next).toEqual({ ...start, width: 650, height: 540 });
  });

  it('never shrinks below the minimum, keeping the anchor honest', () => {
    const next = resizePanel(start, 'w', 500, 0, viewport);
    expect(next.width).toBe(MODAL_MIN_WIDTH);
    expect(next.left + next.width).toBe(start.left + start.width);
  });

  it('never grows past the viewport margin', () => {
    const next = resizePanel(start, 'se', 5000, 5000, viewport);
    expect(next.width).toBe(viewport.width - 2 * MODAL_VIEWPORT_MARGIN);
    expect(next.height).toBe(viewport.height - 2 * MODAL_VIEWPORT_MARGIN);
    expect(next.left).toBe(MODAL_VIEWPORT_MARGIN);
    expect(next.top).toBe(MODAL_VIEWPORT_MARGIN);
  });
});

describe('centeredPanel', () => {
  it('a persisted desktop size restores fully on-screen on a 400px-wide phone (bug 11)', () => {
    const phone = { width: 400, height: 700 };
    const rect = centeredPanel({ width: 800, height: 600 }, phone);
    expect(rect.width).toBe(phone.width - 2 * MODAL_VIEWPORT_MARGIN);
    expect(rect.left + rect.width).toBeLessThanOrEqual(phone.width - MODAL_VIEWPORT_MARGIN);
    expect(rect.height).toBe(600);
  });

  it('centers a persisted size and clamps absurd values', () => {
    expect(centeredPanel({ width: 600, height: 400 }, viewport)).toEqual({
      left: 300,
      top: 200,
      width: 600,
      height: 400,
    });
    const clamped = centeredPanel({ width: 99999, height: 10 }, viewport);
    expect(clamped.width).toBe(viewport.width - 2 * MODAL_VIEWPORT_MARGIN);
    expect(clamped.height).toBe(MODAL_MIN_HEIGHT);
  });
});

describe('maximizedPanel (SEARCH-67)', () => {
  it('fills the whole viewport with no margin', () => {
    expect(maximizedPanel({ width: 1440, height: 900 })).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it('fills exactly the viewport even below the modal minimums (portrait phones, bug 11)', () => {
    expect(maximizedPanel({ width: 400, height: 300 })).toEqual({ left: 0, top: 0, width: 400, height: 300 });
  });
});
