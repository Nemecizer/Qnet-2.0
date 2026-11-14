// Grouped horizontal bars, one group per row, with an interval whisker where a value has one (new
// in 2.1, ROADMAP B1). Rows run down the page so that twenty stations, or long station names, read
// as well as three; bars grow from zero, are at most 24 px thick with a rounded data end, and sit
// 2 px apart inside a group. Every second series is hatched as well as coloured.
import { useId } from "react";
import { axisXHeight, ValueAxisX } from "./axis";
import { ChartShell, headerHeight, type Mark, type TableAlternative } from "./ChartShell";
import { HatchDefs, Legend, legendLayout, type LegendItem } from "./Legend";
import { linearScale, type LinearScale } from "./scale";
import { fitText, SIZE, textWidth, v, type Interval } from "./theme";

export interface BarSeries {
  key: string;
  label: string;
  /** A colour token name ("--series-1"). */
  color: string;
  hatched?: boolean;
}
export interface BarDatum {
  value: number;
  interval?: Interval | null;
}
export interface BarRow {
  key: string;
  label: string;
  /** One per series, in the series' order; null where the series has no value. */
  values: (BarDatum | null)[];
}

export interface BarChartProps {
  width: number;
  rows: BarRow[];
  series: BarSeries[];
  title: string;
  subtitle?: string;
  /** The value axis' label, unit included ("Mean number in system (customers)"). */
  axisLabel: string;
  unit: string;
  /** What a row is ("Station"), for the table. */
  rowTitle: string;
  format: (value: number) => string;
  caption: string;
  fontScale?: number;
}

export interface BarGeometry {
  key: string;
  row: number;
  series: number;
  value: number;
  /** The bar: from zero to the value. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The interval's ends in px, when the value has one. */
  whisker: { x1: number; x2: number } | null;
}

export interface BarLayout {
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  scale: LinearScale;
  rows: { y: number; height: number; label: string }[];
  bars: BarGeometry[];
  legendY: number;
  /** Values are written at the bar ends when there are few enough to read. */
  labelled: boolean;
}

const finiteDatum = (d: BarDatum | null | undefined): d is BarDatum => !!d && Number.isFinite(d.value);
const whole = (i: Interval | null | undefined): i is Interval => !!i && Number.isFinite(i.low) && Number.isFinite(i.high);

/** Where everything goes: pure, so the tests can read the geometry without a browser. */
export function barLayout(props: Pick<BarChartProps, "width" | "rows" | "series" | "subtitle" | "format" | "fontScale"> & { legend?: LegendItem[] }): BarLayout {
  const s = props.fontScale ?? 1;
  const { width, rows, series } = props;
  const n = Math.max(1, series.length);
  const thickness = Math.round((n === 1 ? 14 : n <= 3 ? 11 : 8) * s);
  const gap = 2;
  const group = n * thickness + (n - 1) * gap;
  const rowHeight = group + Math.round(12 * s);
  const count = rows.reduce((k, r) => k + r.values.filter(finiteDatum).length, 0);
  const labelled = count > 0 && count <= 14;
  const legend = props.legend ?? [];
  const legendH = legend.length ? legendLayout(legend, width, s).height + 4 : 0;
  const legendY = headerHeight(props.subtitle, s);
  const top = legendY + legendH + 4;
  const labelSize = SIZE.label * s;
  const gutter = Math.min(width * 0.34, Math.max(40, ...rows.map((r) => textWidth(r.label, labelSize) * 1.05)) + 10);
  const all: number[] = [];
  for (const r of rows) for (const d of r.values) if (finiteDatum(d)) all.push(d.value, ...(whole(d.interval) ? [d.interval.low, d.interval.high] : []));
  const widest = labelled ? Math.max(0, ...rows.flatMap((r) => r.values.filter(finiteDatum).map((d) => textWidth(props.format(d.value), SIZE.tick * s)))) + 10 : 12;
  const left = Math.round(gutter);
  const right = Math.max(left + 60, Math.round(width - widest));
  const scale = linearScale(all, [left, right], { zero: true, count: Math.max(2, Math.min(6, Math.floor((right - left) / 70))) });
  const bars: BarGeometry[] = [];
  const outRows = rows.map((r, i) => {
    const y = top + i * rowHeight;
    r.values.forEach((d, j) => {
      if (!finiteDatum(d) || j >= n) return;
      const x0 = scale(0);
      const x1 = scale(d.value);
      bars.push({
        key: `${r.key}/${series[j]?.key ?? j}`,
        row: i,
        series: j,
        value: d.value,
        x: Math.min(x0, x1),
        y: y + (rowHeight - group) / 2 + j * (thickness + gap),
        width: Math.abs(x1 - x0),
        height: thickness,
        whisker: whole(d.interval) ? { x1: scale(d.interval.low), x2: scale(d.interval.high) } : null,
      });
    });
    return { y, height: rowHeight, label: fitText(r.label, gutter - 10, labelSize) };
  });
  const bottom = top + Math.max(1, rows.length) * rowHeight;
  return { height: bottom + axisXHeight(s), plot: { left, right, top, bottom }, scale, rows: outRows, bars, legendY, labelled };
}

/** A bar from the baseline with a 4-px rounded data end (square at zero). */
function barPath(b: BarGeometry, zero: number): string {
  const r = Math.min(4, b.height / 2, b.width);
  const { x, y, width: w, height: h } = b;
  if (x >= zero - 0.01) return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
}

export function barTable(props: Pick<BarChartProps, "rows" | "series" | "rowTitle" | "format" | "unit" | "title">): TableAlternative {
  const cell = (d: BarDatum | null) => (finiteDatum(d) ? `${props.format(d.value)}${whole(d.interval) ? ` (${props.format(d.interval.low)} to ${props.format(d.interval.high)})` : ""}` : "—");
  return {
    caption: props.title,
    head: [props.rowTitle, ...props.series.map((sr) => (props.unit ? `${sr.label} (${props.unit})` : sr.label))],
    rows: props.rows.map((r) => [r.label, ...props.series.map((_s, j) => cell(r.values[j] ?? null))]),
  };
}

export function BarChart(props: BarChartProps) {
  const scope = useId().replace(/[^\w]/g, "");
  const s = props.fontScale ?? 1;
  const { series, rows, format, unit } = props;
  const legend: LegendItem[] = series.length > 1 ? series.map((sr) => ({ key: sr.key, label: sr.label, color: sr.color, swatch: "bar", hatched: sr.hatched })) : [];
  const L = barLayout({ ...props, legend });
  const zero = L.scale(0);
  const withUnit = (t: string) => (unit ? `${t} ${unit}` : t);
  const marks: Mark[] = L.bars.map((b) => {
    const d = rows[b.row].values[b.series]!;
    const sr = series[b.series];
    const end = Math.max(b.x + b.width, b.whisker?.x2 ?? -Infinity);
    return {
      key: b.key,
      row: b.row,
      col: b.series,
      x: end,
      y: b.y + b.height / 2,
      hit: { x: L.plot.left, y: b.y - 1, width: L.plot.right - L.plot.left, height: b.height + 2 },
      lines: [
        series.length > 1 ? `${rows[b.row].label} · ${sr.label}` : rows[b.row].label,
        withUnit(format(d.value)),
        ...(whole(d.interval) ? [`Interval ${format(d.interval.low)} to ${withUnit(format(d.interval.high))}`] : []),
      ],
    };
  });
  return (
    <ChartShell kind="bar" width={props.width} height={L.height} title={props.title} subtitle={props.subtitle} caption={props.caption} table={barTable(props)} marks={marks} fontScale={s}>
      <HatchDefs scope={scope} />
      {legend.length ? <Legend items={legend} layout={legendLayout(legend, props.width, s)} x={0} y={L.legendY} s={s} scope={scope} /> : null}
      <ValueAxisX scale={L.scale} top={L.plot.top} bottom={L.plot.bottom} label={props.axisLabel} s={s} />
      {L.rows.map((r, i) => (
        <text key={rows[i].key} x={L.plot.left - 8} y={r.y + r.height / 2 + SIZE.label * s * 0.35} fontSize={SIZE.label * s} textAnchor="end" fill={v("--text")} data-row-label>
          {r.label}
        </text>
      ))}
      {L.bars.map((b) => {
        const sr = series[b.series];
        const d = barPath(b, zero);
        const cy = b.y + b.height / 2;
        const tip = Math.max(b.x + b.width, b.whisker?.x2 ?? -Infinity);
        return (
          <g key={b.key} data-bar={b.key}>
            <path d={d} fill={v(sr.color)} />
            {sr.hatched ? <path d={d} fill={`url(#${scope}-hatch)`} /> : null}
            {b.whisker ? (
              <g data-whisker stroke={v("--text")} strokeWidth={1.25} strokeLinecap="round">
                <line x1={b.whisker.x1} x2={b.whisker.x2} y1={cy} y2={cy} />
                <line x1={b.whisker.x1} x2={b.whisker.x1} y1={cy - 3} y2={cy + 3} />
                <line x1={b.whisker.x2} x2={b.whisker.x2} y1={cy - 3} y2={cy + 3} />
              </g>
            ) : null}
            {L.labelled ? (
              <text x={tip + 5} y={cy + SIZE.tick * s * 0.35} fontSize={SIZE.tick * s} fill={v("--text-2")} data-value-label>
                {format(b.value)}
              </text>
            ) : null}
          </g>
        );
      })}
      <line x1={zero} x2={zero} y1={L.plot.top} y2={L.plot.bottom} stroke={v("--border")} strokeWidth={1} />
    </ChartShell>
  );
}
