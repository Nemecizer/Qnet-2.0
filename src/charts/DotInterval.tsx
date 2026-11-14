// A dot with its interval per method, one row per quantity, every row on one shared axis (new in
// 2.1, ROADMAP B1): the form for setting several methods' answers to one question side by side.
// Inside a row each method has its own lane, named at the left, so marks that agree do not hide
// one another and no mark is identified by colour alone; the reference — the value the others are
// measured against — is a rule through the whole row (with its interval as a band) and a ringed mark.
import { useId } from "react";
import { axisXHeight, ValueAxisX } from "./axis";
import { ChartShell, headerHeight, type Mark, type TableAlternative } from "./ChartShell";
import { Legend, legendLayout, type LegendItem } from "./Legend";
import { linearScale, type LinearScale } from "./scale";
import { Shape } from "./shapes";
import { fitText, SIZE, textWidth, v, type Interval, type MarkShape } from "./theme";

export interface DotSeries {
  key: string;
  /** The lane's name (a method's short name). */
  label: string;
  color: string;
  shape: MarkShape;
}
export interface DotValue {
  series: string;
  value: number;
  interval?: Interval | null;
  /** The value the row's others are measured against. */
  reference?: boolean;
  /** An extra read-out line ("2.1 % above the reference"). */
  note?: string;
}
export interface DotRow {
  key: string;
  label: string;
  values: DotValue[];
}

export interface DotIntervalProps {
  width: number;
  rows: DotRow[];
  series: DotSeries[];
  /** What the colours and shapes mean (tiers), and the reference rule. */
  legend: LegendItem[];
  title: string;
  subtitle?: string;
  axisLabel: string;
  unit: string;
  rowTitle: string;
  format: (value: number) => string;
  /** The word after a reference's name in the read-out and the table ("reference"). */
  referenceWord: string;
  intervalWord: string;
  caption: string;
  fontScale?: number;
}

export interface DotGeometry {
  key: string;
  row: number;
  lane: number;
  series: string;
  value: number;
  x: number;
  y: number;
  interval: { x1: number; x2: number } | null;
  reference: boolean;
}

export interface DotLayout {
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  scale: LinearScale;
  laneHeight: number;
  /** x where the lane names start. */
  laneLabelX: number;
  rows: { y: number; height: number; label: string; /** The row's lanes: the series that report it, in the series' order. */ lanes: { series: string; y: number }[]; reference: { x: number; band: { x1: number; x2: number } | null; color: string } | null }[];
  dots: DotGeometry[];
  legendY: number;
}

const whole = (i: Interval | null | undefined): i is Interval => !!i && Number.isFinite(i.low) && Number.isFinite(i.high);

export function dotLayout(props: Pick<DotIntervalProps, "width" | "rows" | "series" | "legend" | "subtitle" | "fontScale">): DotLayout {
  const s = props.fontScale ?? 1;
  const { width, rows, series } = props;
  const laneHeight = Math.round(15 * s);
  const pad = Math.round(10 * s);
  const legendY = headerHeight(props.subtitle, s);
  const legendH = props.legend.length ? legendLayout(props.legend, width, s).height + 4 : 0;
  const top = legendY + legendH + 4;
  const labelSize = SIZE.label * s;
  const tickSize = SIZE.tick * s;
  const rowGutter = Math.min(width * 0.26, Math.max(36, ...rows.map((r) => textWidth(r.label, labelSize, 600) * 1.05)) + 12);
  const laneGutter = Math.min(width * 0.2, Math.max(0, ...series.map((sr) => textWidth(sr.label, tickSize) * 1.05)) + 12);
  const left = Math.round(rowGutter + laneGutter);
  const right = Math.max(left + 60, width - 14);
  const all: number[] = [];
  for (const r of rows) for (const d of r.values) if (Number.isFinite(d.value)) all.push(d.value, ...(whole(d.interval) ? [d.interval.low, d.interval.high] : []));
  const scale = linearScale(all, [left + 8, right - 8], { count: Math.max(2, Math.min(6, Math.floor((right - left) / 80))) });
  const dots: DotGeometry[] = [];
  let y = top;
  const outRows = rows.map((r, i) => {
    const present = series.filter((sr) => r.values.some((d) => d.series === sr.key && Number.isFinite(d.value)));
    const lane = new Map(present.map((sr, k) => [sr.key, k]));
    const rowHeight = Math.max(1, present.length) * laneHeight + pad;
    const rowY = y;
    y += rowHeight;
    const laneY = (k: number) => rowY + pad / 2 + k * laneHeight + laneHeight / 2;
    let reference: DotLayout["rows"][number]["reference"] = null;
    for (const d of r.values) {
      const k = lane.get(d.series);
      if (k === undefined || !Number.isFinite(d.value)) continue;
      const x = scale(d.value);
      const interval = whole(d.interval) ? { x1: scale(d.interval.low), x2: scale(d.interval.high) } : null;
      dots.push({ key: `${r.key}/${d.series}`, row: i, lane: k, series: d.series, value: d.value, x, y: laneY(k), interval, reference: !!d.reference });
      if (d.reference && !reference) reference = { x, band: interval, color: present[k].color };
    }
    return { y: rowY, height: rowHeight, label: fitText(r.label, rowGutter - 12, labelSize, 600), lanes: present.map((sr, k) => ({ series: sr.key, y: laneY(k) })), reference };
  });
  const bottom = Math.max(y, top + laneHeight + pad);
  return { height: bottom + axisXHeight(s), plot: { left, right, top, bottom }, scale, laneHeight, laneLabelX: Math.round(rowGutter), rows: outRows, dots, legendY };
}

export function dotTable(props: Pick<DotIntervalProps, "rows" | "series" | "rowTitle" | "format" | "unit" | "title" | "referenceWord">): TableAlternative {
  return {
    caption: props.title,
    head: [props.rowTitle, ...props.series.map((sr) => (props.unit ? `${sr.label} (${props.unit})` : sr.label))],
    rows: props.rows.map((r) => [
      r.label,
      ...props.series.map((sr) => {
        const d = r.values.find((x) => x.series === sr.key);
        if (!d || !Number.isFinite(d.value)) return "—";
        return `${props.format(d.value)}${whole(d.interval) ? ` (${props.format(d.interval.low)} to ${props.format(d.interval.high)})` : ""}${d.reference ? `, ${props.referenceWord}` : ""}`;
      }),
    ]),
  };
}

export function DotInterval(props: DotIntervalProps) {
  const scope = useId().replace(/[^\w]/g, "");
  const s = props.fontScale ?? 1;
  const { rows, series, format, unit } = props;
  const L = dotLayout(props);
  const bySeries = new Map(series.map((sr) => [sr.key, sr]));
  const withUnit = (t: string) => (unit ? `${t} ${unit}` : t);
  const tickSize = SIZE.tick * s;
  const marks: Mark[] = L.dots.map((d) => {
    const datum = rows[d.row].values.find((x) => x.series === d.series)!;
    const sr = bySeries.get(d.series)!;
    return {
      key: d.key,
      row: d.row * (series.length + 1) + d.lane,
      col: 0,
      x: d.x,
      y: d.y,
      hit: { x: L.laneLabelX, y: d.y - L.laneHeight / 2, width: L.plot.right - L.laneLabelX, height: L.laneHeight },
      lines: [
        `${rows[d.row].label} · ${sr.label}${d.reference ? ` (${props.referenceWord})` : ""}`,
        withUnit(format(d.value)),
        ...(whole(datum.interval) ? [`${props.intervalWord} ${format(datum.interval.low)} to ${withUnit(format(datum.interval.high))}`] : []),
        ...(datum.note ? [datum.note] : []),
      ],
    };
  });
  return (
    <ChartShell kind="dot-interval" width={props.width} height={L.height} title={props.title} subtitle={props.subtitle} caption={props.caption} table={dotTable(props)} marks={marks} fontScale={s}>
      {props.legend.length ? <Legend items={props.legend} layout={legendLayout(props.legend, props.width, s)} x={0} y={L.legendY} s={s} scope={scope} /> : null}
      <ValueAxisX scale={L.scale} top={L.plot.top} bottom={L.plot.bottom} label={props.axisLabel} s={s} />
      {L.rows.map((r, i) => (
        <g key={rows[i].key} data-row={rows[i].key}>
          {i > 0 ? <line x1={0} x2={L.plot.right} y1={r.y} y2={r.y} stroke={v("--hairline")} strokeWidth={1} /> : null}
          <text x={0} y={r.y + r.height / 2 + SIZE.label * s * 0.35} fontSize={SIZE.label * s} fontWeight={600} fill={v("--text")} data-row-label>
            {r.label}
          </text>
          {r.lanes.map((lane) => (
            <text key={lane.series} x={L.laneLabelX} y={lane.y + tickSize * 0.35} fontSize={tickSize} fill={v("--text-2")} data-lane-label>
              {fitText(bySeries.get(lane.series)!.label, L.plot.left - L.laneLabelX - 6, tickSize)}
            </text>
          ))}
          {r.reference ? (
            <g data-reference>
              {r.reference.band ? <rect x={r.reference.band.x1} y={r.y + 2} width={Math.max(0, r.reference.band.x2 - r.reference.band.x1)} height={r.height - 4} fill={v(r.reference.color)} fillOpacity={0.13} /> : null}
              <line x1={r.reference.x} x2={r.reference.x} y1={r.y + 2} y2={r.y + r.height - 2} stroke={v("--text")} strokeWidth={1.5} />
            </g>
          ) : null}
        </g>
      ))}
      {L.dots.map((d) => {
        const sr = bySeries.get(d.series)!;
        return (
          <g key={d.key} data-dot={d.key} data-reference-mark={d.reference || undefined}>
            {d.interval ? (
              <g data-interval stroke={v(sr.color)} strokeWidth={2} strokeLinecap="round">
                <line x1={d.interval.x1} x2={d.interval.x2} y1={d.y} y2={d.y} />
                <line x1={d.interval.x1} x2={d.interval.x1} y1={d.y - 3.5} y2={d.y + 3.5} />
                <line x1={d.interval.x2} x2={d.interval.x2} y1={d.y - 3.5} y2={d.y + 3.5} />
              </g>
            ) : null}
            <Shape shape={sr.shape} x={d.x} y={d.y} r={d.reference ? 4.5 : 4} color={sr.color} emphasis={d.reference} />
          </g>
        );
      })}
    </ChartShell>
  );
}
