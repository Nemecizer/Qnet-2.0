// The two pictures of a fit (new in 2.1, ROADMAP D2), hand-built from the chart primitives
// (src/charts/): the data's histogram with the fitted densities over it, and the empirical
// distribution function against the fitted ones. The data are always series 1 and the chosen
// family series 2; up to two other families are drawn thinner and dashed for comparison. Every
// number drawn comes from `fit_distribution`'s answer; the only arithmetic here is reading a
// curve between two of its grid points.
import { useId } from "react";
import { ChartShell, Legend, ValueAxisX, ValueAxisY, axisXHeight, headerHeight, legendLayout, linearScale, tickLabel, v, SIZE, type LegendItem, type Mark, type TableAlternative } from "../charts";
import { textWidth } from "../charts/theme";
import { formatSig } from "../panes/inspector/distributions/numbers";
import type { FitCandidate, FitReport } from "./model";
import { fitWords as w } from "./words";

const DATA = "--series-1";
const CHOSEN = "--series-2";
const OTHERS = ["--series-3", "--series-4"];
const fmt = (x: number) => formatSig(x, 4);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A curve read at `x`, straight between the two grid points round it. */
export function curveAt(grid: readonly number[], values: readonly (number | null)[], x: number): number | null {
  if (!grid.length || x < grid[0] || x > grid[grid.length - 1]) return null;
  let hi = grid.findIndex((g) => g >= x);
  if (hi <= 0) hi = 1;
  const lo = hi - 1;
  const [a, b] = [values[lo], values[hi]];
  if (a === null || b === null || a === undefined || b === undefined) return null;
  const span = grid[hi] - grid[lo];
  return span > 0 ? a + ((b - a) * (x - grid[lo])) / span : a;
}

/** The families drawn beside the chosen one: the best two others that apply. */
export function comparisons(list: readonly FitCandidate[], chosen: FitCandidate | null): FitCandidate[] {
  return list.filter((c) => c.applicable && c.cdf.length > 0 && c.family !== chosen?.family).slice(0, OTHERS.length);
}

interface Frame {
  width: number;
  fontScale: number;
}

interface Laid {
  s: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  legendY: number;
  height: number;
}

function frame(width: number, s: number, subtitle: string, legend: LegendItem[], yLabels: string[], plotHeight: number): Laid {
  const legendY = headerHeight(subtitle, s);
  const legendH = legend.length ? legendLayout(legend, width, s).height + 4 : 0;
  const top = legendY + legendH + Math.round(SIZE.label * s * 1.9);
  const bottom = top + plotHeight;
  const left = Math.round(Math.max(28, ...yLabels.map((t) => textWidth(t, SIZE.tick * s))) + 10);
  const right = Math.max(left + 60, width - 14);
  return { s, top, bottom, left, right, legendY, height: bottom + axisXHeight(s) };
}

function legendOf(chosen: FitCandidate | null, others: FitCandidate[], dataSwatch: "bar" | "line"): LegendItem[] {
  return [
    { key: "data", label: w.legendData, color: DATA, swatch: dataSwatch },
    ...(chosen ? [{ key: chosen.family, label: chosen.name, color: CHOSEN, swatch: "line" as const }] : []),
    ...others.map((c, i) => ({ key: c.family, label: c.name, color: OTHERS[i], swatch: "line" as const })),
  ];
}

function curvePath(grid: readonly number[], values: readonly (number | null)[], x: (n: number) => number, y: (n: number) => number, yMax: number): string {
  let d = "";
  let pen = false;
  grid.forEach((g, i) => {
    const val = values[i];
    if (val === null || val === undefined || !Number.isFinite(val)) {
      pen = false;
      return;
    }
    // A density that runs off the top (a pole at zero) is held at the frame's edge.
    d += `${pen ? "L" : "M"}${r2(x(g))},${r2(y(Math.min(val, yMax * 1.5)))}`;
    pen = true;
  });
  return d;
}

/** The histogram as a density, with the chosen family's density over it. */
export function DensityChart({ report, list, chosen, width, fontScale }: { report: FitReport; list: readonly FitCandidate[]; chosen: FitCandidate | null } & Frame) {
  const clip = useId().replace(/[^\w]/g, "");
  const s = fontScale;
  const h = report.histogram;
  const others = comparisons(list, chosen);
  const legend = legendOf(chosen, others, "bar");
  const name = chosen?.name ?? w.none;
  const subtitle = w.densitySubtitle(name);
  const barTop = Math.max(...h.density);
  // The frame follows the bars; the chosen curve may rise a quarter above them before it is cut.
  const curveTop = chosen ? Math.max(0, ...chosen.pdf.map((p) => p ?? 0)) : 0;
  const yTop = Math.max(barTop, Math.min(curveTop, barTop * 1.25));
  const probe = linearScale([0, yTop], [100, 0], { zero: true, count: 4 });
  const L = frame(width, s, subtitle, legend, probe.ticks.values.map((t) => tickLabel(t, probe.ticks)), 170);
  const y = linearScale([0, yTop], [L.bottom, L.top], { zero: true, count: 4 });
  const x = linearScale([report.grid[0], report.grid[report.grid.length - 1]], [L.left + 4, L.right - 4], { count: Math.max(2, Math.min(7, Math.floor((L.right - L.left) / 70))) });
  const yMax = Math.max(...y.domain);
  const n = report.summary.n;
  const expected = (i: number): number | null => {
    if (!chosen) return null;
    const [a, b] = [curveAt(report.grid, chosen.cdf, h.edges[i]), curveAt(report.grid, chosen.cdf, h.edges[i + 1])];
    return a === null || b === null ? null : n * (b - a);
  };
  const marks: Mark[] = h.counts.map((count, i) => {
    const [x0, x1] = [x(h.edges[i]), x(h.edges[i + 1])];
    const e = expected(i);
    return {
      key: `bin/${i}`,
      row: 0,
      col: i,
      x: (x0 + x1) / 2,
      y: y(h.density[i]),
      hit: { x: x0, y: L.top, width: Math.max(1, x1 - x0), height: L.bottom - L.top },
      lines: [w.bin(fmt(h.edges[i]), fmt(h.edges[i + 1])), w.binCount(count), ...(chosen && e !== null ? [w.binExpected(chosen.name, fmt(e))] : [])],
    };
  });
  const table: TableAlternative = {
    caption: w.densityTitle,
    head: [w.tableInterval, w.tableCount, ...(chosen ? [w.tableExpected(chosen.name)] : [])],
    rows: h.counts.map((count, i) => {
      const e = expected(i);
      return [w.bin(fmt(h.edges[i]), fmt(h.edges[i + 1])), String(count), ...(chosen ? [e === null ? w.none : fmt(e)] : [])];
    }),
  };
  return (
    <ChartShell kind="fit-density" width={width} height={L.height} title={w.densityTitle} subtitle={subtitle} caption={w.densityCaption(n, h.counts.length, name)} table={table} marks={marks} fontScale={s}>
      <defs>
        <clipPath id={`${clip}-plot`}>
          <rect x={L.left} y={L.top - 2} width={L.right - L.left} height={L.bottom - L.top + 2} />
        </clipPath>
      </defs>
      <Legend items={legend} layout={legendLayout(legend, width, s)} x={0} y={L.legendY} s={s} scope={clip} />
      <ValueAxisY scale={y} left={L.left} right={L.right} label={w.axisDensity} s={s} />
      <ValueAxisX scale={x} top={L.bottom} bottom={L.bottom} label={w.axisTime} s={s} />
      <g clipPath={`url(#${clip}-plot)`}>
        {h.counts.map((_, i) => {
          const [x0, x1] = [x(h.edges[i]), x(h.edges[i + 1])];
          return <rect key={i} data-bin={i} x={r2(x0 + 0.5)} y={r2(y(h.density[i]))} width={r2(Math.max(1, x1 - x0 - 1))} height={r2(Math.max(0, L.bottom - y(h.density[i])))} fill={v(DATA)} fillOpacity={0.45} stroke={v(DATA)} strokeWidth={1} />;
        })}
        {others.map((c, i) => (
          <path key={c.family} data-curve={c.family} d={curvePath(report.grid, c.pdf, x, y, yMax)} fill="none" stroke={v(OTHERS[i])} strokeWidth={1.25} strokeDasharray="5 4" />
        ))}
        {chosen ? <path data-curve={chosen.family} data-chosen d={curvePath(report.grid, chosen.pdf, x, y, yMax)} fill="none" stroke={v(CHOSEN)} strokeWidth={2.25} strokeLinejoin="round" /> : null}
      </g>
    </ChartShell>
  );
}

/** The empirical distribution function (steps) against the fitted ones. */
export function CdfChart({ report, list, chosen, width, fontScale }: { report: FitReport; list: readonly FitCandidate[]; chosen: FitCandidate | null } & Frame) {
  const clip = useId().replace(/[^\w]/g, "");
  const s = fontScale;
  const others = comparisons(list, chosen);
  const legend = legendOf(chosen, others, "line");
  const name = chosen?.name ?? w.none;
  const subtitle = w.cdfSubtitle(name);
  const L = frame(width, s, subtitle, legend, ["0.25", "0.75"], 170);
  const y = linearScale([0, 1], [L.bottom, L.top], { zero: true, count: 4 });
  const x = linearScale([report.grid[0], report.grid[report.grid.length - 1]], [L.left + 4, L.right - 4], { count: Math.max(2, Math.min(7, Math.floor((L.right - L.left) / 70))) });
  // Steps: flat from one observation to the next, then up.
  let steps = `M${r2(x(report.grid[0]))},${r2(y(0))}`;
  let level = 0;
  for (const [px, f] of report.ecdf) {
    steps += `L${r2(x(px))},${r2(y(level))}L${r2(x(px))},${r2(y(f))}`;
    level = f;
  }
  steps += `L${r2(x(report.grid[report.grid.length - 1]))},${r2(y(1))}`;
  const every = Math.max(1, Math.ceil(report.ecdf.length / 24));
  const picked = report.ecdf.filter((_, i) => i % every === every - 1 || i === report.ecdf.length - 1);
  const fitted = (px: number) => (chosen ? curveAt(report.grid, chosen.cdf, px) : null);
  const marks: Mark[] = picked.map(([px, f], i) => {
    const g = fitted(px);
    return {
      key: `ecdf/${i}`,
      row: 0,
      col: i,
      x: x(px),
      y: y(f),
      hit: { x: x(px) - 8, y: L.top, width: 16, height: L.bottom - L.top },
      lines: [w.cdfAt(fmt(px)), w.cdfObserved(fmt(f)), ...(chosen && g !== null ? [w.cdfFitted(chosen.name, fmt(g))] : [])],
    };
  });
  const table: TableAlternative = {
    caption: w.cdfTitle,
    head: [w.tableTime, w.tableObserved, ...(chosen ? [w.tableFitted(chosen.name)] : [])],
    rows: picked.map(([px, f]) => {
      const g = fitted(px);
      return [fmt(px), fmt(f), ...(chosen ? [g === null ? w.none : fmt(g)] : [])];
    }),
  };
  return (
    <ChartShell kind="fit-cdf" width={width} height={L.height} title={w.cdfTitle} subtitle={subtitle} caption={w.cdfCaption(name, chosen?.ks !== null && chosen?.ks !== undefined ? fmt(chosen.ks) : null)} table={table} marks={marks} fontScale={s}>
      <defs>
        <clipPath id={`${clip}-plot`}>
          <rect x={L.left} y={L.top - 2} width={L.right - L.left} height={L.bottom - L.top + 4} />
        </clipPath>
      </defs>
      <Legend items={legend} layout={legendLayout(legend, width, s)} x={0} y={L.legendY} s={s} scope={clip} />
      <ValueAxisY scale={y} left={L.left} right={L.right} label={w.axisFraction} s={s} />
      <ValueAxisX scale={x} top={L.bottom} bottom={L.bottom} label={w.axisTime} s={s} />
      <g clipPath={`url(#${clip}-plot)`}>
        {others.map((c, i) => (
          <path key={c.family} data-curve={c.family} d={curvePath(report.grid, c.cdf, x, y, 1)} fill="none" stroke={v(OTHERS[i])} strokeWidth={1.25} strokeDasharray="5 4" />
        ))}
        {chosen ? <path data-curve={chosen.family} data-chosen d={curvePath(report.grid, chosen.cdf, x, y, 1)} fill="none" stroke={v(CHOSEN)} strokeWidth={2.25} strokeLinejoin="round" /> : null}
        <path data-ecdf d={steps} fill="none" stroke={v(DATA)} strokeWidth={1.75} strokeLinejoin="miter" />
      </g>
    </ChartShell>
  );
}
