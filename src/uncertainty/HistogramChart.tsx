// The distribution of a measure over the sampled cases (new in 2.1, ROADMAP D7): a histogram with
// the middle 95 % shaded, the median as a solid line, the value as drawn as a dashed line and —
// above the bars — the linear approximation's 95 % interval as a bracket, so the contrast between
// the two routes is seen. Nothing rests on colour: each mark has its own form (band, solid line,
// dashed line, bracket), a legend entry and a read-out. Built from the chart primitives
// (src/charts); the bins and every number are Rust's (core/src/uncertainty.rs).
import { useId } from "react";
import { axisXHeight, ChartShell, headerHeight, Legend, legendLayout, linearScale, SIZE, TIER_STYLE, v, ValueAxisX, ValueAxisY, type LegendItem, type Mark, type TableAlternative } from "../charts";
import { pctText, uncertaintyWords as w } from "./words";

export interface HistogramChartProps {
  width: number;
  fontScale?: number;
  title: string;
  subtitle: string;
  caption: string;
  axisLabel: string;
  unit: string;
  format: (x: number) => string;
  histogram: { low: number; high: number; counts: number[]; above: number };
  /** The measure as drawn, the sampled median and the middle 95 %. */
  nominal: number;
  median: number;
  q025: number;
  q975: number;
  /** The linear approximation's interval, when it is shown beside. */
  linear: { low: number; high: number } | null;
}

export function histogramTable(props: Pick<HistogramChartProps, "histogram" | "title" | "format" | "axisLabel">): TableAlternative {
  const { low, high, counts, above } = props.histogram;
  const total = counts.reduce((a, b) => a + b, 0) + above;
  const step = (high - low) / counts.length;
  return {
    caption: props.title,
    head: [props.axisLabel, w.histY],
    rows: counts.map((c, i) => [`${props.format(low + i * step)} – ${props.format(low + (i + 1) * step)}`, pctText((100 * c) / Math.max(1, total))]),
  };
}

export function HistogramChart(props: HistogramChartProps) {
  const scope = useId().replace(/[^\w]/g, "");
  const s = props.fontScale ?? 1;
  const { histogram: h, format, unit } = props;
  const total = h.counts.reduce((a, b) => a + b, 0) + h.above;
  const shares = h.counts.map((c) => c / Math.max(1, total));
  const color = TIER_STYLE.exact.color;
  const linearColor = TIER_STYLE.approximation.color;
  const legend: LegendItem[] = [
    { key: "band", label: w.legendBand, color: "--border", swatch: "bar" },
    { key: "median", label: w.legendMedian, color: "--text", swatch: "rule" },
    { key: "nominal", label: w.legendNominal, color: "--text-2", swatch: "rule" },
    ...(props.linear ? [{ key: "linear", label: w.legendLinear, color: linearColor, swatch: "line" as const }] : []),
  ];
  const layout = legendLayout(legend, props.width, s);
  const legendY = headerHeight(props.subtitle, s);
  const bracketRoom = props.linear ? Math.round(16 * s) : 0;
  const top = legendY + layout.height + Math.round(SIZE.label * s * 1.6) + bracketRoom;
  const bottom = top + Math.round(170 * s);
  const left = Math.round(46 * s);
  const right = props.width - 10;
  const x = linearScale([h.low, h.high, props.nominal], [left, right], { count: Math.max(3, Math.min(8, Math.floor((right - left) / 80))) });
  const y = linearScale([0, ...shares], [bottom, top], { zero: true, count: 4 });
  const step = (h.high - h.low) / h.counts.length;
  const clamp = (px: number) => Math.max(left, Math.min(right, px));
  const inside = (value: number) => value >= x.domain[0] && value <= x.domain[1];
  const bars = shares.map((share, i) => ({ i, share, x0: x(h.low + i * step), x1: x(h.low + (i + 1) * step) }));
  const lin = props.linear;
  const bracketY = top - Math.round(8 * s);

  const marks: Mark[] = [
    ...bars.map((b) => ({
      key: `bin-${b.i}`,
      row: 1,
      col: b.i,
      x: (b.x0 + b.x1) / 2,
      y: y(b.share),
      hit: { x: b.x0, y: top, width: Math.max(1, b.x1 - b.x0), height: bottom - top },
      lines: [w.histBin(format(h.low + b.i * step), format(h.low + (b.i + 1) * step), unit), w.histShare(pctText(b.share * 100))],
    })),
    { key: "band", row: 0, col: 0, x: clamp(x(props.q025)), y: top, hit: { x: clamp(x(props.q025)) - 4, y: top - 12 * s - bracketRoom, width: 8, height: 12 * s }, lines: [w.legendBand, w.markBand(format(props.q025), format(props.q975), unit)] },
    { key: "median", row: 0, col: 1, x: clamp(x(props.median)), y: top, hit: { x: clamp(x(props.median)) - 4, y: top - 12 * s - bracketRoom, width: 8, height: 12 * s }, lines: [w.legendMedian, w.markMedian(format(props.median), unit)] },
    { key: "nominal", row: 0, col: 2, x: clamp(x(props.nominal)), y: top, hit: { x: clamp(x(props.nominal)) - 4, y: top - 12 * s - bracketRoom, width: 8, height: 12 * s }, lines: [w.legendNominal, w.markNominal(format(props.nominal), unit)] },
    ...(lin ? [{ key: "linear", row: 0, col: 3, x: clamp(x(lin.high)), y: bracketY, hit: { x: clamp(x(lin.low)), y: bracketY - 5, width: Math.max(8, clamp(x(lin.high)) - clamp(x(lin.low))), height: 10 }, lines: [w.legendLinear, w.markLinear(format(lin.low), format(lin.high), unit)] }] : []),
  ];

  return (
    <ChartShell kind="histogram" width={props.width} height={bottom + axisXHeight(s)} title={props.title} subtitle={props.subtitle} caption={props.caption} table={histogramTable(props)} marks={marks} fontScale={s}>
      <Legend items={legend} layout={layout} x={0} y={legendY} s={s} scope={scope} />
      <rect x={clamp(x(props.q025))} y={top} width={Math.max(0, clamp(x(props.q975)) - clamp(x(props.q025)))} height={bottom - top} fill={v("--border")} fillOpacity={0.45} data-band />
      <ValueAxisY scale={y} left={left} right={right} label={w.histY} s={s} />
      <ValueAxisX scale={x} top={top} bottom={bottom} label={props.axisLabel} s={s} />
      {bars.map((b) => (
        <rect key={b.i} x={b.x0 + 0.5} y={y(b.share)} width={Math.max(0.5, b.x1 - b.x0 - 1)} height={Math.max(0, bottom - y(b.share))} fill={v(color)} data-bin={b.i} />
      ))}
      {inside(props.median) ? <line x1={x(props.median)} x2={x(props.median)} y1={top - 4} y2={bottom} stroke={v("--text")} strokeWidth={1.75} data-median /> : null}
      {inside(props.nominal) ? <line x1={x(props.nominal)} x2={x(props.nominal)} y1={top - 4} y2={bottom} stroke={v("--text-2")} strokeWidth={1.5} strokeDasharray="5 3" data-nominal /> : null}
      {lin ? (
        <g data-linear stroke={v(linearColor)} strokeWidth={2} strokeLinecap="round" fill="none">
          <line x1={clamp(x(lin.low))} x2={clamp(x(lin.high))} y1={bracketY} y2={bracketY} />
          {/* An end inside the plot gets a tick; one beyond it is left open, with an arrowhead. */}
          {inside(lin.low) ? <line x1={x(lin.low)} x2={x(lin.low)} y1={bracketY - 4} y2={bracketY + 4} /> : <path d={`M${left + 5},${bracketY - 4}L${left},${bracketY}L${left + 5},${bracketY + 4}`} />}
          {inside(lin.high) ? <line x1={x(lin.high)} x2={x(lin.high)} y1={bracketY - 4} y2={bracketY + 4} /> : <path d={`M${right - 5},${bracketY - 4}L${right},${bracketY}L${right - 5},${bracketY + 4}`} />}
        </g>
      ) : null}
    </ChartShell>
  );
}
