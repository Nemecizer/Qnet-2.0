// The dot / line grid (docs/specs/canvas.md §8, 0.90.34 `GridPath.build`), as plain data the
// drawing layer renders: the minor dots (1.5 pt squares) and the major hairlines, each with its
// alpha, plus SVG path strings for the two. Display space; the loops accumulate `x += step` as the
// Swift did, so the same dots land on the same fractional positions.
import { roundSwift, swiftMax, swiftMin } from "./math";
import { GRID_SPACING, type CanvasTransform } from "./transform";
import type { Rect, Size } from "./types";

/** Side of one minor dot, display pt. */
export const GRID_DOT_SIZE = 1.5;
/** Cell size (display pt) at and below which the minor dots are gone. */
export const MINOR_FADE_START = 16;
/** Cell-size band over which the minor dots fade in. */
export const MINOR_FADE_WIDTH = 8;

export interface GridLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface GridResult {
  /** Display pt between minor dots (gridSpacing × scale) and between major lines (× 4). */
  readonly cell: number;
  readonly major: number;
  /** null: nothing to draw at this zoom. */
  readonly minorDots: readonly Rect[] | null;
  readonly minorAlpha: number;
  readonly majorLines: readonly GridLine[] | null;
  readonly majorAlpha: number;
}

/** First grid line at or after display 0 for a world grid shifted by `offset` display pt. */
export function firstLine(offset: number, step: number): number {
  let v = offset % step; // truncatingRemainder
  if (v < 0) v += step;
  return v;
}

export function buildGrid(transform: CanvasTransform, size: Size, gridSpacing: number = GRID_SPACING): GridResult {
  const cell = gridSpacing * transform.scale;
  const major = cell * 4;
  if (!(cell > 0.5)) return { cell, major, minorDots: null, minorAlpha: 0, majorLines: null, majorAlpha: 0 };

  const minorAlpha = swiftMin(1, swiftMax(0, (cell - MINOR_FADE_START) / MINOR_FADE_WIDTH));
  let minorDots: Rect[] | null = null;
  if (minorAlpha > 0.02) {
    minorDots = [];
    const x0 = firstLine(transform.pan.width, cell);
    const y0 = firstLine(transform.pan.height, cell);
    const d = GRID_DOT_SIZE;
    const h = d / 2;
    let x = x0;
    while (x <= size.width) {
      let y = y0;
      while (y <= size.height) {
        minorDots.push({ x: x - h, y: y - h, width: d, height: d });
        y += cell;
      }
      x += cell;
    }
  }

  const majorAlpha = swiftMin(1, swiftMax(0, (major - 4) / 8));
  let majorLines: GridLine[] | null = null;
  if (majorAlpha > 0) {
    majorLines = [];
    let x = firstLine(transform.pan.width, major);
    while (x <= size.width) {
      const px = roundSwift(x) + 0.5;
      majorLines.push({ x1: px, y1: 0, x2: px, y2: size.height });
      x += major;
    }
    let y = firstLine(transform.pan.height, major);
    while (y <= size.height) {
      const py = roundSwift(y) + 0.5;
      majorLines.push({ x1: 0, y1: py, x2: size.width, y2: py });
      y += major;
    }
  }
  return { cell, major, minorDots, minorAlpha, majorLines, majorAlpha };
}

/** `GridPath.build`, under 0.90.34's name. */
export const GridPath = { build: buildGrid, firstLine } as const;

/** The minor dots as one SVG path `d` (one closed square per dot), or "" when none. */
export function gridDotsPath(g: GridResult): string {
  if (!g.minorDots) return "";
  let s = "";
  for (const r of g.minorDots) s += `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}Z`;
  return s;
}

/** The major hairlines as one SVG path `d`, or "" when none. */
export function gridLinesPath(g: GridResult): string {
  if (!g.majorLines) return "";
  let s = "";
  for (const l of g.majorLines) s += `M${l.x1} ${l.y1}L${l.x2} ${l.y2}`;
  return s;
}
