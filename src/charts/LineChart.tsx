// Several series over a numeric x, each a 2-px line with a marker at every point and, where the
// points carry an interval, a band in the series' colour at a tenth of its strength (new in 2.1,
// ROADMAP B1; the parameter sweeps draw with it). Each series has its own marker shape.
import { useId } from "react";
import { ValueAxisY, axisXHeight } from "./axis";
import { ChartShell, headerHeight, type Mark, type TableAlternative } from "./ChartShell";
import { Legend, legendLayout, type LegendItem } from "./Legend";
import { linearScale, type LinearScale } from "./scale";
import { Shape } from "./shapes";
import { SERIES_SHAPES, SIZE, textWidth, v, type MarkShape } from "./theme";
import { tickLabel } from "./scale";

export interface LinePoint {
  x: number;
  y: number;
  low?: number | null;
  high?: number | null;
  /** No value here (a point that could not be computed): the line breaks instead of bridging it. */
  gap?: boolean;
}
/** A vertical rule across the plot at an x value: where the parameter is now, or where the system stops being stable. */
export interface LineRule {
  x: number;
  label: string;
  /** "current" is a solid hairline; "limit" a dashed warning line (an asymptote). */
  tone: "current" | "limit";
  /** Which side of the rule its label sits on (default: the side with more room). */
  side?: "left" | "right";
}
export interface LineSeries {
  key: string;
  label: string;
  color: string;
  shape?: MarkShape;
  points: LinePoint[];
}

export interface LineChartProps {
  width: number;
  /** The plot's height (the chart adds its title, legend and axis). */
  plotHeight?: number;
  series: LineSeries[];
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  unit: string;
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  intervalWord?: string;
  caption: string;
  fontScale?: number;
  /** Vertical rules; one outside the x range drawn is left out. */
  rules?: LineRule[];
}

export interface LineGeometry {
  key: string;
  /** The line through the series' finite points, in x order. */
  path: string;
  /** The interval band's outline, when at least two points have one. */
  band: string | null;
  points: { x: number; y: number; px: number; py: number; low: number | null; high: number | null }[];
}

export interface LineLayout {
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  x: LinearScale;
  y: LinearScale;
  lines: LineGeometry[];
  legendY: number;
  rules: (LineRule & { px: number })[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function lineLayout(props: Pick<LineChartProps, "width" | "plotHeight" | "series" | "subtitle" | "fontScale" | "rules"> & { legend?: LegendItem[] }): LineLayout {
  const s = props.fontScale ?? 1;
  const { width, series } = props;
  const legend = props.legend ?? [];
  const legendY = headerHeight(props.subtitle, s);
  const legendH = legend.length ? legendLayout(legend, width, s).height + 4 : 0;
  const top = legendY + legendH + Math.round(SIZE.label * s * 1.9);
  const bottom = top + (props.plotHeight ?? 220);
  const clean = series.map((sr) => sr.points.filter((p) => !p.gap && Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x));
  // Where each series has no value: the x axis still spans these, and the line breaks at them.
  const gaps = series.map((sr) => sr.points.filter((p) => p.gap && Number.isFinite(p.x)).map((p) => p.x));
  const ys: number[] = [];
  for (const pts of clean) for (const p of pts) ys.push(p.y, ...(Number.isFinite(p.low) && Number.isFinite(p.high) ? [p.low as number, p.high as number] : []));
  const y = linearScale(ys, [bottom, top], { count: 5 });
  const left = Math.round(Math.max(28, ...y.ticks.values.map((t) => textWidth(tickLabel(t, y.ticks), SIZE.tick * s))) + 10);
  const right = Math.max(left + 60, width - 14);
  const x = linearScale([...clean.flatMap((pts) => pts.map((p) => p.x)), ...gaps.flat()], [left + 6, right - 6], { count: Math.max(2, Math.min(8, Math.floor((right - left) / 80))) });
  const lines = series.map((sr, i) => {
    const points = clean[i].map((p) => {
      const has = Number.isFinite(p.low) && Number.isFinite(p.high);
      return { x: p.x, y: p.y, px: r2(x(p.x)), py: r2(y(p.y)), low: has ? (p.low as number) : null, high: has ? (p.high as number) : null };
    });
    // The runs of points with no gap between them: one stroke (and one band) each.
    const runs: (typeof points)[] = [];
    for (const [k, p] of points.entries()) {
      const broken = k > 0 && gaps[i].some((g) => g > points[k - 1].x && g < p.x);
      if (!k || broken) runs.push([]);
      runs[runs.length - 1].push(p);
    }
    const path = runs.map((run) => run.map((p, k) => `${k ? "L" : "M"}${p.px},${p.py}`).join("")).join("");
    const bands = runs
      .map((run) => run.filter((p) => p.low !== null && p.high !== null))
      .filter((banded) => banded.length >= 2)
      .map((banded) => `${banded.map((p, k) => `${k ? "L" : "M"}${p.px},${r2(y(p.high as number))}`).join("")}${[...banded].reverse().map((p) => `L${p.px},${r2(y(p.low as number))}`).join("")}Z`);
    return { key: sr.key, path, band: bands.length ? bands.join("") : null, points };
  });
  const [x0, x1] = [Math.min(...x.domain), Math.max(...x.domain)];
  const rules = (props.rules ?? []).filter((r) => Number.isFinite(r.x) && r.x >= x0 && r.x <= x1).map((r) => ({ ...r, px: r2(x(r.x)) }));
  return { height: bottom + axisXHeight(s), plot: { left, right, top, bottom }, x, y, lines, legendY, rules };
}

export function lineTable(props: Pick<LineChartProps, "series" | "xLabel" | "formatX" | "formatY" | "unit" | "title">): TableAlternative {
  const xs = [...new Set(props.series.flatMap((sr) => sr.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => p.x)))].sort((a, b) => a - b);
  return {
    caption: props.title,
    head: [props.xLabel, ...props.series.map((sr) => (props.unit ? `${sr.label} (${props.unit})` : sr.label))],
    rows: xs.map((x) => [
      props.formatX(x),
      ...props.series.map((sr) => {
        const p = sr.points.find((q) => q.x === x && Number.isFinite(q.y));
        if (!p) return "—";
        return `${props.formatY(p.y)}${Number.isFinite(p.low) && Number.isFinite(p.high) ? ` (${props.formatY(p.low as number)} to ${props.formatY(p.high as number)})` : ""}`;
      }),
    ]),
  };
}

export function LineChart(props: LineChartProps) {
  const scope = useId().replace(/[^\w]/g, "");
  const s = props.fontScale ?? 1;
  const { series, unit } = props;
  const shapeOf = (i: number) => series[i].shape ?? SERIES_SHAPES[i % SERIES_SHAPES.length];
  const legend: LegendItem[] = series.length > 1 ? series.map((sr, i) => ({ key: sr.key, label: sr.label, color: sr.color, swatch: shapeOf(i) })) : [];
  const L = lineLayout({ ...props, legend });
  const withUnit = (t: string) => (unit ? `${t} ${unit}` : t);
  const marks: Mark[] = L.lines.flatMap((line, i) =>
    line.points.map((p, k) => ({
      key: `${line.key}/${k}`,
      row: i,
      col: k,
      x: p.px,
      y: p.py,
      hit: { x: p.px - 9, y: p.py - 9, width: 18, height: 18 },
      lines: [
        series.length > 1 ? `${series[i].label} · ${props.xLabel} ${props.formatX(p.x)}` : `${props.xLabel} ${props.formatX(p.x)}`,
        withUnit(props.formatY(p.y)),
        ...(p.low !== null && p.high !== null ? [`${props.intervalWord ?? "Interval"} ${props.formatY(p.low)} to ${withUnit(props.formatY(p.high))}`] : []),
      ],
    })),
  );
  return (
    <ChartShell kind="line" width={props.width} height={L.height} title={props.title} subtitle={props.subtitle} caption={props.caption} table={lineTable(props)} marks={marks} fontScale={s}>
      {legend.length ? <Legend items={legend} layout={legendLayout(legend, props.width, s)} x={0} y={L.legendY} s={s} scope={scope} /> : null}
      <ValueAxisY scale={L.y} left={L.plot.left} right={L.plot.right} label={props.yLabel} s={s} />
      <g data-axis="x">
        {L.x.ticks.values.map((t) => (
          <text key={t} x={L.x(t)} y={L.plot.bottom + SIZE.tick * s * 1.35} fontSize={SIZE.tick * s} textAnchor="middle" fill={v("--muted")} data-tick>
            {tickLabel(t, L.x.ticks)}
          </text>
        ))}
        <text x={(L.plot.left + L.plot.right) / 2} y={L.plot.bottom + (SIZE.tick * 1.35 + SIZE.label * 1.5) * s} fontSize={SIZE.label * s} textAnchor="middle" fill={v("--text-2")} data-axis-label>
          {props.xLabel}
        </text>
      </g>
      {L.rules.map((r, i) => {
        const limit = r.tone === "limit";
        const toRight = (r.side ?? (r.px < (L.plot.left + L.plot.right) / 2 ? "right" : "left")) === "right";
        return (
          <g key={i} data-rule={r.tone} data-rule-x={r.x}>
            <line x1={r.px} x2={r.px} y1={L.plot.top} y2={L.plot.bottom} stroke={v(limit ? "--crit-text" : "--text-2")} strokeWidth={limit ? 1.5 : 1} strokeDasharray={limit ? "5 4" : undefined} />
            <text x={r.px + (toRight ? 5 : -5)} y={L.plot.top + SIZE.tick * s * (limit ? 1 : 2.3)} fontSize={SIZE.tick * s} textAnchor={toRight ? "start" : "end"} fill={v(limit ? "--crit-text" : "--text-2")}>
              {r.label}
            </text>
          </g>
        );
      })}
      {L.lines.map((line, i) => (line.band ? <path key={line.key} d={line.band} fill={v(series[i].color)} fillOpacity={0.12} data-band={line.key} /> : null))}
      {L.lines.map((line, i) => (
        <g key={line.key} data-line={line.key}>
          {line.points.length > 1 ? <path d={line.path} fill="none" stroke={v(series[i].color)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
          {line.points.map((p, k) => (
            <Shape key={k} shape={shapeOf(i)} x={p.px} y={p.py} r={4} color={series[i].color} />
          ))}
        </g>
      ))}
    </ChartShell>
  );
}


