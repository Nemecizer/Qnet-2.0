// The ranked elasticity chart (new in 2.1, ROADMAP D1): one horizontal bar per parameter, the
// one that moves the measure most at the top. A bar to the right of zero raises the measure, one
// to the left lowers it; the sign is also written on the bar's label ("+3.33", "−1.67") and a
// lowering bar is hatched, so direction never rests on colour. Built from the chart primitives
// (src/charts): the bars' geometry, the axis, the read-out and the table alternative are theirs.
import { useId } from "react";
import { barLayout, ChartShell, HatchDefs, Legend, legendLayout, SIZE, TIER_STYLE, v, ValueAxisX, type LegendItem, type Mark, type TableAlternative } from "../charts";
import type { Tier } from "../results/insight";
import { signed, sensitivityWords as w } from "./words";

export interface ElasticityBar {
  key: string;
  label: string;
  elasticity: number;
  /** The read-out's extra lines (the plain reading). */
  lines: string[];
}

export interface ElasticityChartProps {
  width: number;
  bars: ElasticityBar[];
  tier: Tier;
  title: string;
  caption: string;
  fontScale?: number;
}

export function elasticityTable(props: Pick<ElasticityChartProps, "bars" | "title">): TableAlternative {
  return { caption: props.title, head: [w.rowTitle, w.colElasticity], rows: props.bars.map((b) => [b.label, signed(b.elasticity)]) };
}

export function ElasticityChart(props: ElasticityChartProps) {
  const scope = useId().replace(/[^\w]/g, "");
  const s = props.fontScale ?? 1;
  const color = TIER_STYLE[props.tier].color;
  const legend: LegendItem[] = [
    { key: "raises", label: w.legendRaises, color, swatch: "bar" },
    { key: "lowers", label: w.legendLowers, color, swatch: "bar", hatched: true },
  ];
  const rows = props.bars.map((b) => ({ key: b.key, label: b.label, values: [{ value: b.elasticity }] }));
  const L = barLayout({ width: props.width, rows, series: [{ key: "e", label: w.colElasticity, color }], subtitle: w.chartSubtitle, format: signed, fontScale: s, legend });
  const zero = L.scale(0);
  const marks: Mark[] = L.bars.map((b) => ({
    key: b.key,
    row: b.row,
    col: 0,
    x: b.value < 0 ? b.x : b.x + b.width,
    y: b.y + b.height / 2,
    hit: { x: L.plot.left, y: b.y - 2, width: L.plot.right - L.plot.left, height: b.height + 4 },
    lines: [props.bars[b.row].label, `${w.colElasticity}: ${signed(b.value)}`, ...props.bars[b.row].lines],
  }));
  return (
    <ChartShell kind="elasticity" width={props.width} height={L.height} title={props.title} subtitle={w.chartSubtitle} caption={props.caption} table={elasticityTable(props)} marks={marks} fontScale={s}>
      <HatchDefs scope={scope} />
      <Legend items={legend} layout={legendLayout(legend, props.width, s)} x={0} y={L.legendY} s={s} scope={scope} />
      <ValueAxisX scale={L.scale} top={L.plot.top} bottom={L.plot.bottom} label={w.chartAxis} s={s} />
      {L.rows.map((r, i) => (
        <text key={rows[i].key} x={L.plot.left - 8} y={r.y + r.height / 2 + SIZE.label * s * 0.35} fontSize={SIZE.label * s} textAnchor="end" fill={v("--text")} data-row-label>
          {r.label}
        </text>
      ))}
      {L.bars.map((b) => {
        const lowers = b.value < 0;
        const cy = b.y + b.height / 2;
        // The value sits beyond the bar's end, on the side the bar points to — unless that would
        // leave the plot, when it goes to the other side of zero.
        const outside = lowers ? b.x - 5 : b.x + b.width + 5;
        const fits = lowers ? outside - 34 * s > L.plot.left : outside + 34 * s < props.width;
        const x = fits ? outside : lowers ? zero + 5 : zero - 5;
        const anchor = (fits ? lowers : !lowers) ? "end" : "start";
        return (
          <g key={b.key} data-bar={b.key} data-sign={lowers ? "lowers" : "raises"}>
            <rect x={b.x} y={b.y} width={Math.max(b.width, 1)} height={b.height} rx={2} fill={v(color)} />
            {lowers ? <rect x={b.x} y={b.y} width={Math.max(b.width, 1)} height={b.height} rx={2} fill={`url(#${scope}-hatch)`} /> : null}
            <text x={x} y={cy + SIZE.tick * s * 0.35} fontSize={SIZE.tick * s} textAnchor={anchor} fill={v("--text-2")} data-value-label>
              {signed(b.value)}
            </text>
          </g>
        );
      })}
      <line x1={zero} x2={zero} y1={L.plot.top} y2={L.plot.bottom} stroke={v("--text-2")} strokeWidth={1} />
    </ChartShell>
  );
}
