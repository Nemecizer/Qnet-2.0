// The legend: a swatch (the mark's own shape, or a bar or line key) and a label in a text token,
// laid out in rows that wrap at the chart's width (new in 2.1).
import { Shape } from "./shapes";
import { SIZE, textWidth, v, type MarkShape } from "./theme";

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** A mark's shape, a bar swatch, or a line key. */
  swatch: MarkShape | "bar" | "line" | "rule";
  hatched?: boolean;
}

export interface LegendLayout {
  height: number;
  items: { x: number; y: number; width: number }[];
}

const SWATCH = 14;
const GAP = 16;

/** Where each item goes when the row wraps at `width`. */
export function legendLayout(items: readonly LegendItem[], width: number, s = 1): LegendLayout {
  const size = SIZE.label * s;
  const line = Math.round(size * 1.7);
  let x = 0;
  let y = 0;
  const out = items.map((it) => {
    const w = SWATCH + 5 + textWidth(it.label, size) * 1.04;
    if (x > 0 && x + w > width) {
      x = 0;
      y += line;
    }
    const at = { x, y, width: w };
    x += w + GAP;
    return at;
  });
  return { height: items.length ? y + line : 0, items: out };
}

/** Diagonal surface-coloured lines to lay over a filled bar, so every second series differs by more than hue. */
export function HatchDefs({ scope }: { scope: string }) {
  return (
    <defs>
      <pattern id={`${scope}-hatch`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={1.6} height={5} fill={v("--surface")} fillOpacity={0.55} />
      </pattern>
    </defs>
  );
}

export function Legend({ items, layout, x, y, s = 1, scope }: { items: readonly LegendItem[]; layout: LegendLayout; x: number; y: number; s?: number; scope: string }) {
  const size = SIZE.label * s;
  return (
    <g data-legend transform={`translate(${x},${y})`}>
      {items.map((it, i) => {
        const at = layout.items[i];
        const cy = at.y + size * 0.62;
        return (
          <g key={it.key} data-legend-item={it.key}>
            {it.swatch === "bar" ? (
              <>
                <rect x={at.x + 1} y={cy - 5} width={12} height={10} rx={2} fill={v(it.color)} />
                {it.hatched ? <rect x={at.x + 1} y={cy - 5} width={12} height={10} rx={2} fill={`url(#${scope}-hatch)`} /> : null}
              </>
            ) : it.swatch === "line" ? (
              <line x1={at.x} x2={at.x + SWATCH} y1={cy} y2={cy} stroke={v(it.color)} strokeWidth={2} strokeLinecap="round" />
            ) : it.swatch === "rule" ? (
              <line x1={at.x + SWATCH / 2} x2={at.x + SWATCH / 2} y1={cy - 7} y2={cy + 7} stroke={v(it.color)} strokeWidth={1.5} />
            ) : (
              <Shape shape={it.swatch} x={at.x + SWATCH / 2} y={cy} r={4} color={it.color} />
            )}
            <text x={at.x + SWATCH + 5} y={at.y + size} fontSize={size} fill={v("--text-2")}>
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
