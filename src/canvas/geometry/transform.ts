// World ↔ display mapping (docs/specs/canvas.md §3, 0.90.34 `CanvasTransform`).
// `display = world · scale + pan`. At zoom 1 with no pan, world == display, so documents written
// before zoom existed open in place.
import type { Point, Rect, Size } from "./types";

export interface CanvasTransform {
  readonly scale: number;
  readonly pan: Size;
  readonly viewportSize: Size;
}

export const IDENTITY: CanvasTransform = Object.freeze({ scale: 1, pan: { width: 0, height: 0 }, viewportSize: { width: 0, height: 0 } });

/** Single source of truth for the zoom limits: menus, cluster, wheel, pinch and every fit. */
export const ZOOM_RANGE = { lower: 0.1, upper: 4.0 } as const;
/** Geometric step for ⌘= / ⌘− and the zoom cluster's buttons. */
export const ZOOM_STEP = 1.25;
/** Per wheel notch, applied as 1.1^delta. */
export const WHEEL_ZOOM_FACTOR = 1.1;
/** Grid cell and snap step, world pt. */
export const GRID_SPACING = 28;
/** Zoom to Fit's margin, display pt. */
export const FIT_MARGIN = 88;
/** CanvasMath.clampWorld: sanity only, the canvas is otherwise unbounded. */
export const WORLD_CLAMP = 100_000;

export function makeTransform(scale: number, pan: Size, viewportSize: Size): CanvasTransform {
  return { scale, pan, viewportSize };
}

export function toDisplay(t: CanvasTransform, p: Point): Point {
  return { x: p.x * t.scale + t.pan.width, y: p.y * t.scale + t.pan.height };
}

export function toLogical(t: CanvasTransform, p: Point): Point {
  if (!(t.scale > 0)) return p;
  return { x: (p.x - t.pan.width) / t.scale, y: (p.y - t.pan.height) / t.scale };
}

/** Maps the origin and scales the size. */
export function rectToDisplay(t: CanvasTransform, r: Rect): Rect {
  const o = toDisplay(t, r);
  return { x: o.x, y: o.y, width: r.width * t.scale, height: r.height * t.scale };
}

/** The world rect the viewport shows. */
export function visibleWorldRect(t: CanvasTransform): Rect {
  const a = toLogical(t, { x: 0, y: 0 });
  const b = toLogical(t, { x: t.viewportSize.width, y: t.viewportSize.height });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function viewportCentre(t: CanvasTransform): Point {
  return { x: t.viewportSize.width / 2, y: t.viewportSize.height / 2 };
}

/** Zoom keeping the world point under `displayAnchor` fixed. */
export function zoomed(t: CanvasTransform, newScale: number, displayAnchor: Point): CanvasTransform {
  const world = toLogical(t, displayAnchor);
  return {
    scale: newScale,
    pan: { width: displayAnchor.x - world.x * newScale, height: displayAnchor.y - world.y * newScale },
    viewportSize: t.viewportSize,
  };
}

/** Room at the canvas's edges that floating chrome takes (the results legend at the top, the animation's control bar at the bottom), in display pt. */
export interface Insets {
  top: number;
  bottom: number;
}
export const NO_INSETS: Insets = { top: 0, bottom: 0 };

/** Chrome may reserve at most this share of the canvas's height between top and bottom; beyond it the fit ignores the excess rather than shrink the network to nothing. */
export const MAX_INSET_SHARE = 0.5;

/**
 * The room chrome reserves in a canvas `surface` (all in one coordinate frame): what the boxes
 * hanging from the top edge reach down to, and what the boxes standing on the bottom edge reach
 * up to. A box with no size (not drawn) reserves nothing; the two together are capped at
 * `MAX_INSET_SHARE` of the height, in proportion.
 */
export function chromeInsets(surface: Rect, top: readonly Rect[], bottom: readonly Rect[]): Insets {
  const drawn = (r: Rect) => r.width > 0 && r.height > 0;
  const t = Math.max(0, ...top.filter(drawn).map((r) => r.y + r.height - surface.y));
  const b = Math.max(0, ...bottom.filter(drawn).map((r) => surface.y + surface.height - r.y));
  const cap = Math.max(0, surface.height) * MAX_INSET_SHARE;
  const k = t + b > cap && t + b > 0 ? cap / (t + b) : 1;
  return { top: t * k, bottom: b * k };
}

/**
 * Frames `worldRect` centred, with `margin` display pt on every side. With `insets` it is framed
 * in what the chrome leaves free: the margins start at the insets, and the centre is the centre
 * of the free band, so nothing fitted lies under the legend or the animation's control bar.
 */
export function fitting(worldRect: Rect, viewport: Size, margin: number, range: { lower: number; upper: number } = ZOOM_RANGE, insets: Insets = NO_INSETS): CanvasTransform {
  const free = Math.max(viewport.height - insets.top - insets.bottom, 1);
  const availW = Math.max(viewport.width - 2 * margin, 1);
  const availH = Math.max(free - 2 * margin, 1);
  const raw = Math.min(availW / Math.max(worldRect.width, 1), availH / Math.max(worldRect.height, 1));
  const scale = Math.min(range.upper, Math.max(range.lower, raw));
  const cx = worldRect.x + worldRect.width / 2;
  const cy = worldRect.y + worldRect.height / 2;
  return {
    scale,
    pan: { width: viewport.width / 2 - cx * scale, height: insets.top + free / 2 - cy * scale },
    viewportSize: viewport,
  };
}

/** Clamps a scale to ZOOM_RANGE. */
export function clampScale(s: number): number {
  return Math.min(ZOOM_RANGE.upper, Math.max(ZOOM_RANGE.lower, s));
}

export function transformsEqual(a: CanvasTransform, b: CanvasTransform): boolean {
  return (
    a.scale === b.scale &&
    a.pan.width === b.pan.width &&
    a.pan.height === b.pan.height &&
    a.viewportSize.width === b.viewportSize.width &&
    a.viewportSize.height === b.viewportSize.height
  );
}
