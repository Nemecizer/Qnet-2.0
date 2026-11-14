// The marks a chart places at a value: one shape per tier or series, so two marks differ by more
// than colour. Each is drawn round (x, y) inside a circle of radius `r`.
import type { MarkShape } from "./theme";
import { v } from "./theme";

const n = (x: number) => Math.round(x * 100) / 100;

/** The outline of `shape` as path data. */
export function shapePath(shape: MarkShape, x: number, y: number, r: number): string {
  switch (shape) {
    case "diamond": {
      const d = r * 1.25;
      return `M${n(x)},${n(y - d)}L${n(x + d)},${n(y)}L${n(x)},${n(y + d)}L${n(x - d)},${n(y)}Z`;
    }
    case "square": {
      const h = r * 0.9;
      return `M${n(x - h)},${n(y - h)}H${n(x + h)}V${n(y + h)}H${n(x - h)}Z`;
    }
    case "triangle": {
      const d = r * 1.2;
      return `M${n(x)},${n(y - d)}L${n(x + d)},${n(y + d * 0.8)}L${n(x - d)},${n(y + d * 0.8)}Z`;
    }
    case "cross": {
      const a = r * 1.1;
      const b = r * 0.4;
      return `M${n(x - b)},${n(y - a)}H${n(x + b)}V${n(y - b)}H${n(x + a)}V${n(y + b)}H${n(x + b)}V${n(y + a)}H${n(x - b)}V${n(y + b)}H${n(x - a)}V${n(y - b)}H${n(x - b)}Z`;
    }
    default:
      return `M${n(x - r)},${n(y)}a${n(r)},${n(r)} 0 1,0 ${n(2 * r)},0a${n(r)},${n(r)} 0 1,0 ${n(-2 * r)},0Z`;
  }
}

/** A mark: filled in its colour with a 2-px ring of the surface, so it stays legible on a line or another mark. */
export function Shape({ shape, x, y, r = 4, color, emphasis }: { shape: MarkShape; x: number; y: number; r?: number; color: string; emphasis?: boolean }) {
  const d = shapePath(shape, x, y, r);
  if (shape === "ring") return <path d={shapePath("circle", x, y, r - 1)} fill={v("--surface")} stroke={v(color)} strokeWidth={2} data-shape={shape} />;
  return (
    <>
      {emphasis ? <path d={d} fill="none" stroke={v("--text")} strokeWidth={5} strokeLinejoin="round" data-emphasis /> : null}
      <path d={d} fill={v(color)} stroke={v("--surface")} strokeWidth={emphasis ? 1.5 : 2} strokeLinejoin="round" paintOrder="stroke" data-shape={shape} />
    </>
  );
}
