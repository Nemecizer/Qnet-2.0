// The Transient view's chart (new in 2.1, ROADMAP D4): the mean number at each station against
// time. One colour per station; the tier is told by the line, not the colour — exact solid,
// fluid dashed — and each station's long-run average is a dotted line in its colour. The surge's
// window is shaded, and a diamond marks where each exact curve settles. Built from the chart
// primitives (src/charts): the shell gives the read-out, the keyboard and the table alternative,
// and the figure exports as every other chart does.
import { ChartShell, headerHeight, legendLayout, linearScale, Shape, SIZE, tickLabel, v, ValueAxisY, axisXHeight, type LegendItem, type Mark, type TableAlternative } from "../charts";
import { sampleIndices, valueAt } from "./model";
import { transientWords as w } from "./words";

export interface TransientSeries {
  key: string;
  /** The station's name. */
  label: string;
  /** A colour token ("--series-1"). */
  color: string;
  exact: number[] | null;
  fluid: number[] | null;
  /** The long-run average, exact. */
  stationary: number | null;
  /** Where the exact curve settles. */
  settling: number | null;
  /** The pointwise stationary approximation (null where it has no value), when the rates change in time. */
  psa?: (number | null)[] | null;
}

export interface TransientChartProps {
  width: number;
  fontScale?: number;
  plotHeight?: number;
  times: number[];
  series: TransientSeries[];
  surge: { factor: number; from: number; until: number } | null;
  /** The times at which a stored rate profile changes. */
  breaks?: number[];
  /** "5 %". */
  band: string;
  title: string;
  subtitle: string;
  caption: string;
  table: TableAlternative;
  formatY: (y: number) => string;
  formatX: (x: number) => string;
}

export const FLUID_DASH = "7 4";
export const STATIONARY_DASH = "1.5 3.5";
/** The pointwise stationary approximation: long dash, dot. */
export const PSA_DASH = "9 3 2 3";
/** PSA is drawn up to this many times the highest exact or fluid value; beyond it leaves the chart. */
export const PSA_CEILING = 2.5;

const r2 = (n: number) => Math.round(n * 100) / 100;

type Key = LegendItem & { dash?: string; thin?: boolean };

export function TransientChart(props: TransientChartProps) {
  const s = props.fontScale ?? 1;
  const { width, times, series, surge } = props;
  const anyExact = series.some((sr) => sr.exact);
  const anyFluid = series.some((sr) => sr.fluid);
  const keys: Key[] = [
    ...series.flatMap((sr): Key[] => [
      ...(sr.exact ? [{ key: `${sr.key}/exact`, label: w.exactOf(sr.label), color: sr.color, swatch: "line" as const }] : []),
      ...(sr.fluid ? [{ key: `${sr.key}/fluid`, label: w.fluidOf(sr.label), color: sr.color, swatch: "line" as const, dash: FLUID_DASH }] : []),
      ...(sr.psa ? [{ key: `${sr.key}/psa`, label: w.psaOf(sr.label), color: sr.color, swatch: "line" as const, dash: PSA_DASH, thin: true }] : []),
    ]),
    ...(series.some((sr) => sr.stationary !== null) ? [{ key: "stationary", label: w.legendStationary, color: "--text-2", swatch: "line" as const, dash: STATIONARY_DASH, thin: true }] : []),
    ...(series.some((sr) => sr.settling !== null) ? [{ key: "settled", label: w.legendSettled(props.band), color: "--text-2", swatch: "diamond" as const }] : []),
  ];
  const legendY = headerHeight(props.subtitle, s);
  const legend = legendLayout(keys, width, s);
  const top = legendY + legend.height + 4 + Math.round(SIZE.label * s * 1.9);
  const bottom = top + (props.plotHeight ?? 260);
  const own = [0, ...series.flatMap((sr) => [...(sr.exact ?? []), ...(sr.fluid ?? []), ...(sr.stationary !== null ? [sr.stationary] : [])])];
  // PSA can be many times the true mean (that is what it is shown for): it widens the scale up
  // to a ceiling and is cut off above it, so the exact curves stay readable.
  const ceiling = Math.max(...own) * PSA_CEILING;
  const ys = [...own, ...series.flatMap((sr) => (sr.psa ?? []).filter((p): p is number => p !== null).map((p) => Math.min(p, ceiling)))];
  const y = linearScale(ys, [bottom, top], { count: 5, zero: true });
  const left = Math.round(Math.max(28, ...y.ticks.values.map((t) => tickLabel(t, y.ticks).length * SIZE.tick * s * 0.62)) + 10);
  const right = Math.max(left + 60, width - 14);
  const x = linearScale([times[0], times[times.length - 1]], [left, right], { count: Math.max(2, Math.min(8, Math.floor((right - left) / 80))) });
  const path = (values: number[]) => values.map((val, k) => `${k ? "L" : "M"}${r2(x(times[k]))},${r2(y(val))}`).join("");
  // PSA is piecewise constant with gaps: one sub-path per run of values, cut at the ceiling.
  const psaPath = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((val, k) => {
      if (val === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${r2(x(times[k]))},${r2(y(Math.min(val, ceiling)))}`;
      pen = true;
    });
    return d;
  };
  const size = SIZE.label * s;

  // The read-out's marks: about forty moments per curve, the surge's ends among them.
  const idx = sampleIndices(times, 40, surge ? [surge.from, surge.until] : (props.breaks ?? []));
  const marks: Mark[] = [];
  let row = 0;
  for (const sr of series) {
    for (const [tier, values] of [["exact", sr.exact], ["fluid", sr.fluid]] as const) {
      if (!values) continue;
      idx.forEach((k, col) => {
        const [px, py] = [r2(x(times[k])), r2(y(values[k]))];
        marks.push({
          key: `${sr.key}/${tier}/${k}`,
          row,
          col,
          x: px,
          y: py,
          hit: { x: px - 5, y: py - 9, width: 10, height: 18 },
          lines: [`${tier === "exact" ? w.exactOf(sr.label) : w.fluidOf(sr.label)} · ${w.atTime(props.formatX(times[k]))}`, `${props.formatY(values[k])} ${w.unit}`],
        });
      });
      row++;
    }
  }

  const [t0, t1] = [times[0], times[times.length - 1]];
  const band = surge && surge.from < t1 ? { x0: x(Math.max(t0, surge.from)), x1: x(Math.min(t1, surge.until)) } : null;

  return (
    <ChartShell kind="transient" width={width} height={bottom + axisXHeight(s)} title={props.title} subtitle={props.subtitle} caption={props.caption} table={props.table} marks={marks} fontScale={s}>
      <g data-legend transform={`translate(0,${legendY})`}>
        {keys.map((it, i) => {
          const at = legend.items[i];
          const cy = at.y + size * 0.62;
          return (
            <g key={it.key} data-legend-item={it.key}>
              {it.swatch === "line" ? (
                <line x1={at.x} x2={at.x + 14} y1={cy} y2={cy} stroke={v(it.color)} strokeWidth={it.thin ? 1.5 : 2} strokeDasharray={it.dash} strokeLinecap={it.dash ? "butt" : "round"} />
              ) : (
                <Shape shape="diamond" x={at.x + 7} y={cy} r={4} color={it.color} />
              )}
              <text x={at.x + 19} y={at.y + size} fontSize={size} fill={v("--text-2")}>
                {it.label}
              </text>
            </g>
          );
        })}
      </g>
      {band ? (
        <g data-surge>
          <rect x={r2(band.x0)} y={top} width={r2(Math.max(1, band.x1 - band.x0))} height={bottom - top} fill={v("--text")} fillOpacity={0.07} />
          <text x={r2(band.x0) + 4} y={top + SIZE.tick * s * 1.1} fontSize={SIZE.tick * s} fill={v("--text-2")}>
            {w.surgeBand(props.formatX(surge!.factor))}
          </text>
        </g>
      ) : null}
      <ValueAxisY scale={y} left={left} right={right} label={w.yLabel} s={s} />
      <g data-axis="x">
        {x.ticks.values
          .filter((t) => t >= t0 && t <= x.domain[1])
          .map((t) => (
            <text key={t} x={x(t)} y={bottom + SIZE.tick * s * 1.35} fontSize={SIZE.tick * s} textAnchor="middle" fill={v("--muted")} data-tick>
              {tickLabel(t, x.ticks)}
            </text>
          ))}
        <text x={(left + right) / 2} y={bottom + (SIZE.tick * 1.35 + SIZE.label * 1.5) * s} fontSize={SIZE.label * s} textAnchor="middle" fill={v("--text-2")} data-axis-label>
          {w.xLabel}
        </text>
      </g>
      {series.map((sr) =>
        sr.stationary !== null ? (
          <line key={sr.key} data-stationary={sr.key} x1={left} x2={r2(x(t1))} y1={r2(y(sr.stationary))} y2={r2(y(sr.stationary))} stroke={v(sr.color)} strokeWidth={1.5} strokeDasharray={STATIONARY_DASH} strokeLinecap="round" />
        ) : null,
      )}
      {(props.breaks ?? []).map((t) => (
        <line key={t} data-profile-break={t} x1={r2(x(t))} x2={r2(x(t))} y1={top} y2={bottom} stroke={v("--border")} strokeWidth={1} strokeDasharray="2 3" />
      ))}
      {series.map((sr) => (sr.psa ? <path key={sr.key} data-line={`${sr.key}/psa`} data-tier="psa" d={psaPath(sr.psa)} fill="none" stroke={v(sr.color)} strokeWidth={1.5} strokeDasharray={PSA_DASH} strokeLinejoin="miter" /> : null))}
      {anyFluid ? series.map((sr) => (sr.fluid ? <path key={sr.key} data-line={`${sr.key}/fluid`} data-tier="fluid" d={path(sr.fluid)} fill="none" stroke={v(sr.color)} strokeWidth={2} strokeDasharray={FLUID_DASH} strokeLinejoin="round" /> : null)) : null}
      {anyExact ? series.map((sr) => (sr.exact ? <path key={sr.key} data-line={`${sr.key}/exact`} data-tier="exact" d={path(sr.exact)} fill="none" stroke={v(sr.color)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null)) : null}
      {series.map((sr) => {
        if (sr.settling === null || !sr.exact || sr.settling > t1) return null;
        const [px, py] = [r2(x(sr.settling)), r2(y(valueAt(times, sr.exact, sr.settling)))];
        return (
          <g key={sr.key} data-settling={sr.key} data-settling-time={sr.settling}>
            <line x1={px} x2={px} y1={py} y2={bottom} stroke={v(sr.color)} strokeWidth={1} />
            <Shape shape="diamond" x={px} y={py} r={4.5} color={sr.color} />
          </g>
        );
      })}
    </ChartShell>
  );
}
