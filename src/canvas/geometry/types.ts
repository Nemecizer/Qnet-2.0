// Plain value types for the canvas: points, sizes and rects in CoreGraphics' sense (origin at the
// top-left, y down), so the arithmetic ported from 0.90.34's CanvasGeometry.swift reads the same.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ZERO_POINT: Point = Object.freeze({ x: 0, y: 0 });
export const ZERO_SIZE: Size = Object.freeze({ width: 0, height: 0 });

export const pt = (x: number, y: number): Point => ({ x, y });
export const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

export const minX = (r: Rect) => r.x;
export const minY = (r: Rect) => r.y;
export const maxX = (r: Rect) => r.x + r.width;
export const maxY = (r: Rect) => r.y + r.height;
export const midX = (r: Rect) => r.x + r.width / 2;
export const midY = (r: Rect) => r.y + r.height / 2;

/** CGRect.insetBy(dx:dy:): a negative inset grows the rect. */
export function insetBy(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}

/**
 * CGRect.intersects: true when the two share interior area. Like CoreGraphics, a rect with zero
 * width or height intersects nothing, which is why marqueeSelects insets its band first.
 */
export function intersects(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** CGRect.union of two rects. */
export function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, width: Math.max(maxX(a), maxX(b)) - x0, height: Math.max(maxY(a), maxY(b)) - y0 };
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}
