// A value axis with its gridlines, tick labels and a label that carries the unit (new in 2.1).
// Gridlines are solid hairlines, one step off the surface; the labels are in text tokens.
import type { LinearScale } from "./scale";
import { tickLabel } from "./scale";
import { SIZE, v } from "./theme";

/** A horizontal value axis under a plot that runs from `top` to `bottom`. */
export function ValueAxisX({ scale, top, bottom, label, s = 1 }: { scale: LinearScale; top: number; bottom: number; label: string; s?: number }) {
  const size = SIZE.tick * s;
  const [r0, r1] = scale.range;
  return (
    <g data-axis="x">
      {scale.ticks.values.map((t) => (
        <g key={t}>
          <line x1={scale(t)} x2={scale(t)} y1={top} y2={bottom} stroke={v(t === 0 ? "--border" : "--hairline")} strokeWidth={1} />
          <text x={scale(t)} y={bottom + size * 1.35} fontSize={size} textAnchor="middle" fill={v("--muted")} data-tick>
            {tickLabel(t, scale.ticks)}
          </text>
        </g>
      ))}
      <text x={(r0 + r1) / 2} y={bottom + size * 1.35 + SIZE.label * s * 1.5} fontSize={SIZE.label * s} textAnchor="middle" fill={v("--text-2")} data-axis-label>
        {label}
      </text>
    </g>
  );
}

/** The room `ValueAxisX` takes under the plot. */
export const axisXHeight = (s = 1) => Math.round((SIZE.tick * 1.35 + SIZE.label * 1.5 + 6) * s);

/** A vertical value axis left of a plot that runs from `left` to `right`; its label sits above the ticks. */
export function ValueAxisY({ scale, left, right, label, s = 1 }: { scale: LinearScale; left: number; right: number; label: string; s?: number }) {
  const size = SIZE.tick * s;
  return (
    <g data-axis="y">
      {scale.ticks.values.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={scale(t)} y2={scale(t)} stroke={v(t === 0 ? "--border" : "--hairline")} strokeWidth={1} />
          <text x={left - 6} y={scale(t) + size * 0.35} fontSize={size} textAnchor="end" fill={v("--muted")} data-tick>
            {tickLabel(t, scale.ticks)}
          </text>
        </g>
      ))}
      <text x={0} y={Math.min(...scale.range) - SIZE.label * s * 0.9} fontSize={SIZE.label * s} fill={v("--text-2")} data-axis-label>
        {label}
      </text>
    </g>
  );
}
