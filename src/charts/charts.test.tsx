// The chart primitives against recorded runs (golden/runs/): geometry, the keyboard read-out, the
// text alternative, the frame and the export string (ledger VIZ-004…VIZ-012).
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { interval } from "../results/insight";
import type { ResultRecord } from "../panes/results/model";
import { BarChart, barLayout, type BarRow, type BarSeries } from "./BarChart";
import { ChartFrame } from "./ChartFrame";
import { nextMark, type Mark } from "./ChartShell";
import { DotInterval, dotLayout, type DotRow, type DotSeries } from "./DotInterval";
import { legendLayout, type LegendItem } from "./Legend";
import { LineChart, lineLayout, type LineSeries } from "./LineChart";
import { shapePath } from "./shapes";
import { chartSvgString, resolveTokens } from "./svgString";
import { fitText, TIER_STYLE } from "./theme";

const records = import.meta.glob("../../golden/runs/{5stationtandem.inf,3d2ctandem.inf}/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const golden = (example: string, method: string) => JSON.parse(records[`../../golden/runs/${example}/${method}/record.json`]) as ResultRecord;

const METRIC = "Mean number in system";
const fmt = (x: number) => x.toFixed(3);

/** A run's all-classes values for the metric, one row per station, as the pane builds them. */
function stationRows(run: ResultRecord): BarRow[] {
  return run.measurements.filter((m) => m.metric === METRIC && typeof m.customerClass !== "number").map((m) => ({ key: m.stationID!, label: m.stationName, values: [{ value: m.estimate, interval: interval(m) }] }));
}

const regen = golden("5stationtandem.inf", "regenerative_mc");
const qna = golden("5stationtandem.inf", "qna");
const exact = golden("5stationtandem.inf", "product_form");
const one: BarSeries[] = [{ key: "value", label: "Regen MC", color: "--tier-simulation" }];
const barProps = { rows: stationRows(regen), series: one, title: `${METRIC} by station`, subtitle: "Regenerative Monte Carlo", axisLabel: `${METRIC} (customers)`, unit: "customers", rowTitle: "Station", format: fmt, caption: "Five stations." };

// A multi-class run: two classes at three stations.
const multi = golden("3d2ctandem.inf", "regenerative_mc");
const classSeries: BarSeries[] = [
  { key: "c0", label: "Class 1", color: "--series-1" },
  { key: "c1", label: "Class 2", color: "--series-2", hatched: true },
];
function classRows(run: ResultRecord): BarRow[] {
  const rows = new Map<string, BarRow>();
  for (const m of run.measurements) {
    if (m.metric !== METRIC || typeof m.customerClass !== "number") continue;
    const row = rows.get(m.stationID!) ?? { key: m.stationID!, label: m.stationName, values: [null, null] };
    row.values[m.customerClass] = { value: m.estimate, interval: interval(m) };
    rows.set(m.stationID!, row);
  }
  return [...rows.values()];
}

describe("BarChart", () => {
  it("draws one bar per station from zero to the value, with the interval as a whisker", () => {
    const L = barLayout({ width: 640, ...barProps });
    expect(L.bars).toHaveLength(5);
    expect(L.scale.domain[0]).toBe(0);
    const zero = L.scale(0);
    for (const [i, b] of L.bars.entries()) {
      const m = regen.measurements.filter((x) => x.metric === METRIC && typeof x.customerClass !== "number")[i];
      expect(b.x).toBeCloseTo(zero, 6);
      expect(b.x + b.width).toBeCloseTo(L.scale(m.estimate), 6);
      expect(b.height).toBeLessThanOrEqual(24);
      const ci = interval(m)!;
      expect(b.whisker!.x1).toBeCloseTo(L.scale(ci.low), 6);
      expect(b.whisker!.x2).toBeCloseTo(L.scale(ci.high), 6);
      expect(b.whisker!.x1).toBeLessThan(b.x + b.width);
      expect(b.whisker!.x2).toBeGreaterThan(b.x + b.width);
      // Inside the plot, each row under the last.
      expect(b.whisker!.x2).toBeLessThanOrEqual(L.plot.right);
      if (i) expect(b.y).toBeGreaterThan(L.bars[i - 1].y + L.bars[i - 1].height);
    }
    expect(L.plot.left).toBeGreaterThan(0);
    expect(L.plot.right).toBeLessThan(640);
  });

  it("draws no whisker for a method that gives no interval", () => {
    const L = barLayout({ width: 640, ...barProps, rows: stationRows(qna) });
    expect(L.bars.every((b) => b.whisker === null)).toBe(true);
    const { container } = render(<BarChart width={640} {...barProps} rows={stationRows(qna)} />);
    expect(container.querySelectorAll("[data-whisker]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(5);
    // One series: no legend; the title says what is plotted.
    expect(container.querySelector("[data-legend]")).toBeNull();
  });

  it("groups one bar per class in each station, 2 px apart, with a legend and a hatch on the second", () => {
    const rows = classRows(multi);
    expect(rows).toHaveLength(3);
    const L = barLayout({ width: 640, rows, series: classSeries, format: fmt, legend: classSeries.map((s) => ({ key: s.key, label: s.label, color: s.color, swatch: "bar" as const })) });
    expect(L.bars).toHaveLength(6);
    for (let r = 0; r < 3; r++) {
      const [a, b] = L.bars.filter((x) => x.row === r);
      expect(b.y - (a.y + a.height)).toBe(2);
      expect(a.width).toBeCloseTo(L.scale(rows[r].values[0]!.value) - L.scale(0), 6);
    }
    const { container } = render(<BarChart width={640} {...barProps} rows={rows} series={classSeries} />);
    expect([...container.querySelectorAll("[data-legend-item]")].map((n) => n.textContent)).toEqual(["Class 1", "Class 2"]);
    expect(container.querySelectorAll('[data-bar] path[fill^="url(#"]')).toHaveLength(3);
    expect(container.querySelectorAll("[data-whisker]")).toHaveLength(6);
  });

  it("leaves out values that are not numbers and still lays out an empty chart", () => {
    const rows: BarRow[] = [
      { key: "a", label: "A", values: [{ value: NaN }] },
      { key: "b", label: "B", values: [{ value: 2, interval: { low: NaN, high: 3 } }] },
      { key: "c", label: "C", values: [null] },
    ];
    const L = barLayout({ width: 400, rows, series: one, format: fmt });
    expect(L.bars.map((b) => b.key)).toEqual(["b/value"]);
    expect(L.bars[0].whisker).toBeNull();
    expect(Number.isFinite(barLayout({ width: 400, rows: [], series: one, format: fmt }).height)).toBe(true);
  });

  it("writes the values at the bar ends only while there are few enough to read", () => {
    expect(barLayout({ width: 640, ...barProps }).labelled).toBe(true);
    const many: BarRow[] = Array.from({ length: 20 }, (_, i) => ({ key: `s${i}`, label: `Station ${i + 1}`, values: [{ value: i + 1 }] }));
    const L = barLayout({ width: 640, rows: many, series: one, format: fmt });
    expect(L.labelled).toBe(false);
    expect(L.bars).toHaveLength(20);
  });
});

const methods = [exact, golden("5stationtandem.inf", "inf_sim"), qna];
const dotSeries: DotSeries[] = [
  { key: "pf", label: "Product Form", ...TIER_STYLE.exact },
  { key: "sim", label: "Monte Carlo", ...TIER_STYLE.simulation },
  { key: "qna", label: "QNA", ...TIER_STYLE.approximation },
];
const dotRows: DotRow[] = stationRows(exact).map((r, i) => ({
  key: r.key,
  label: r.label,
  values: methods.map((run, k) => {
    const m = run.measurements.filter((x) => x.metric === METRIC && typeof x.customerClass !== "number")[i];
    return { series: dotSeries[k].key, value: m.estimate, interval: interval(m), reference: k === 0, note: k === 2 ? "0 % above the reference" : undefined };
  }),
}));
const legend: LegendItem[] = [
  { key: "exact", label: "Exact", color: "--tier-exact", swatch: "circle" },
  { key: "simulation", label: "Simulation (95 % interval)", color: "--tier-simulation", swatch: "diamond" },
  { key: "approximation", label: "Approximation", color: "--tier-approximation", swatch: "square" },
  { key: "reference", label: "Reference", color: "--text", swatch: "rule" },
];
const dotProps = { rows: dotRows, series: dotSeries, legend, title: `${METRIC}: every method`, axisLabel: `${METRIC} (customers)`, unit: "customers", rowTitle: "Station", format: fmt, referenceWord: "reference", intervalWord: "Interval", caption: "Three methods." };

describe("DotInterval", () => {
  it("puts every method's value for a station on one shared axis, each in its own lane", () => {
    const L = dotLayout({ width: 720, ...dotProps });
    expect(L.dots).toHaveLength(15);
    for (const d of L.dots) {
      expect(d.x).toBeCloseTo(L.scale(d.value), 6);
      expect(d.x).toBeGreaterThanOrEqual(L.plot.left);
      expect(d.x).toBeLessThanOrEqual(L.plot.right);
    }
    const first = L.dots.filter((d) => d.row === 0);
    expect(first.map((d) => d.lane)).toEqual([0, 1, 2]);
    expect(first[1].y - first[0].y).toBe(L.laneHeight);
    // Position, not length: the axis need not start at zero.
    expect(L.scale.domain[0]).toBeGreaterThan(0);
    // The simulation's interval is drawn; the exact result and the approximation have none.
    const sim = first[1];
    const m = methods[1].measurements.find((x) => x.metric === METRIC)!;
    expect(sim.interval!.x1).toBeCloseTo(L.scale(interval(m)!.low), 6);
    expect(sim.interval!.x2).toBeCloseTo(L.scale(interval(m)!.high), 6);
    expect(first[0].interval).toBeNull();
    expect(first[2].interval).toBeNull();
  });

  it("draws the reference distinctly: a rule through its row and a ringed mark", () => {
    const L = dotLayout({ width: 720, ...dotProps });
    expect(L.rows.every((r) => r.reference && r.reference.band === null)).toBe(true);
    expect(L.rows[0].reference!.x).toBeCloseTo(L.dots[0].x, 6);
    const { container } = render(<DotInterval width={720} {...dotProps} />);
    expect(container.querySelectorAll("[data-reference] line")).toHaveLength(5);
    expect(container.querySelectorAll("[data-reference-mark] [data-emphasis]")).toHaveLength(5);
    expect(container.querySelectorAll("[data-emphasis]")).toHaveLength(5);
    expect(container.querySelectorAll("[data-interval]")).toHaveLength(5);
    // Shape as well as colour: a circle, a diamond and a square.
    expect([...new Set([...container.querySelectorAll("[data-dot] [data-shape]")].map((n) => n.getAttribute("data-shape")))]).toEqual(["circle", "diamond", "square"]);
    expect([...container.querySelectorAll("[data-row]")][0].querySelectorAll("[data-lane-label]")).toHaveLength(3);
  });

  it("shades the reference's interval when the reference is a simulation, and gives a row only the lanes it has", () => {
    const rows: DotRow[] = [
      { key: "a", label: "S1", values: [{ series: "sim", value: 9, interval: { low: 8.5, high: 9.5 }, reference: true }, { series: "qna", value: 9.2 }] },
      { key: "b", label: "S2", values: [{ series: "qna", value: 4 }, { series: "pf", value: NaN }] },
    ];
    const L = dotLayout({ width: 600, ...dotProps, rows });
    expect(L.rows[0].reference!.band).toEqual({ x1: L.scale(8.5), x2: L.scale(9.5) });
    expect(L.rows[0].lanes.map((l) => l.series)).toEqual(["sim", "qna"]);
    expect(L.rows[1].lanes.map((l) => l.series)).toEqual(["qna"]);
    expect(L.rows[1].reference).toBeNull();
    expect(L.rows[1].height).toBeLessThan(L.rows[0].height);
    expect(L.dots).toHaveLength(3);
  });
});

const sweep: LineSeries[] = [
  { key: "sim", label: "Simulation", color: "--series-1", points: [0.5, 0.7, 0.9].map((rho) => ({ x: rho, y: rho / (1 - rho), low: rho / (1 - rho) - 0.2, high: rho / (1 - rho) + 0.2 })) },
  { key: "qna", label: "QNA", color: "--series-2", points: [{ x: 0.9, y: 9.1 }, { x: 0.5, y: 1.02 }, { x: 0.7, y: NaN }, { x: NaN, y: 3 }] },
];
const lineProps = { series: sweep, title: "Mean number in system against load", xLabel: "Load ρ", yLabel: "Mean number in system (customers)", unit: "customers", formatX: (x: number) => x.toFixed(1), formatY: fmt, caption: "A sweep." };

describe("LineChart", () => {
  it("draws each series through its finite points in x order, with a band where there are intervals", () => {
    const L = lineLayout({ width: 640, ...lineProps });
    expect(L.lines[0].points).toHaveLength(3);
    expect(L.lines[1].points.map((p) => p.x)).toEqual([0.5, 0.9]);
    for (const p of L.lines[0].points) {
      expect(p.px).toBeCloseTo(L.x(p.x), 1);
      expect(p.py).toBeCloseTo(L.y(p.y), 1);
    }
    // y runs upward: a larger value is higher on the page.
    expect(L.lines[0].points[2].py).toBeLessThan(L.lines[0].points[0].py);
    expect(L.lines[0].path).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
    expect(L.lines[0].band).toMatch(/Z$/);
    expect(L.lines[1].band).toBeNull();
    const { container } = render(<LineChart width={640} {...lineProps} />);
    expect(container.querySelectorAll("[data-line]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-band]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-line] [data-shape]")).toHaveLength(5);
    expect(new Set([...container.querySelectorAll("[data-line] [data-shape]")].map((n) => n.getAttribute("data-shape"))).size).toBe(2);
    expect([...container.querySelectorAll("[data-legend-item]")].map((n) => n.textContent)).toEqual(["Simulation", "QNA"]);
  });
});

describe("the read-out", () => {
  const svg = (c: HTMLElement) => c.querySelector("svg[data-chart]") as SVGSVGElement;
  const live = (c: HTMLElement) => c.querySelector("[data-chart-live]")!.textContent;

  it("is one tab stop; arrow keys move it from mark to mark and say what each is", () => {
    const { container } = render(<BarChart width={640} {...barProps} />);
    const el = svg(container);
    expect(el).toHaveAttribute("tabindex", "0");
    expect(container.querySelector("[data-readout]")).toBeNull();
    act(() => el.focus());
    fireEvent.keyDown(el, { key: "ArrowDown" });
    const s1 = regen.measurements.find((m) => m.metric === METRIC && typeof m.customerClass !== "number")!;
    const ci = interval(s1)!;
    expect(live(container)).toBe(`S1. ${fmt(s1.estimate)} customers. Interval ${fmt(ci.low)} to ${fmt(ci.high)} customers`);
    expect([...container.querySelectorAll("[data-readout] text")].map((t) => t.textContent)).toEqual(["S1", `${fmt(s1.estimate)} customers`, `Interval ${fmt(ci.low)} to ${fmt(ci.high)} customers`]);
    expect(container.querySelector("[data-active-mark]")).toHaveAttribute("data-active-mark", "S1/value".replace("S1", barProps.rows[0].key));
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(live(container)).toMatch(/^S2\. /);
    fireEvent.keyDown(el, { key: "End" });
    expect(live(container)).toMatch(/^S5\. /);
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(live(container)).toMatch(/^S5\. /);
    fireEvent.keyDown(el, { key: "Home" });
    expect(live(container)).toMatch(/^S1\. /);
    fireEvent.keyDown(el, { key: "Escape" });
    expect(live(container)).toBe("");
    expect(container.querySelector("[data-readout]")).toBeNull();
  });

  it("moves between the classes of a station with ← →, and between stations with ↑ ↓ keeping the class", () => {
    const { container } = render(<BarChart width={640} {...barProps} rows={classRows(multi)} series={classSeries} />);
    const el = svg(container);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(live(container)).toMatch(/^S1 · Class 1\. /);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(live(container)).toMatch(/^S1 · Class 2\. /);
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(live(container)).toMatch(/^S2 · Class 2\. /);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(live(container)).toMatch(/^S3 · Class 1\. /);
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(live(container)).toMatch(/^S2 · Class 2\. /);
  });

  it("follows the pointer, and goes away when the pointer or the focus leaves", () => {
    const { container } = render(<DotInterval width={720} {...dotProps} />);
    const el = svg(container);
    const hits = container.querySelectorAll("[data-mark]");
    expect(hits).toHaveLength(15);
    fireEvent.pointerEnter(hits[2]);
    expect(live(container)).toBe(`S1 · QNA. ${fmt(9)} customers. 0 % above the reference`);
    fireEvent.pointerEnter(hits[0]);
    expect(live(container)).toMatch(/^S1 · Product Form \(reference\)\. /);
    fireEvent.pointerLeave(el);
    expect(live(container)).toBe("");
    act(() => el.focus());
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(live(container)).toMatch(/^S1 · Monte Carlo\. .* Interval /);
    fireEvent.blur(el);
    expect(live(container)).toBe("");
  });

  it("leaves other keys, and arrows with a modifier, to the app", () => {
    const { container } = render(<BarChart width={640} {...barProps} />);
    const el = svg(container);
    expect(fireEvent.keyDown(el, { key: "ArrowDown", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(el, { key: "a" })).toBe(true);
    expect(live(container)).toBe("");
    expect(fireEvent.keyDown(el, { key: "ArrowDown" })).toBe(false);
  });

  it("finds the neighbouring mark on a ragged grid", () => {
    const m = (row: number, col: number): Mark => ({ key: `${row}/${col}`, row, col, x: 0, y: 0, hit: { x: 0, y: 0, width: 1, height: 1 }, lines: [] });
    const marks = [m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(3, 1)];
    expect(nextMark(marks, null, "ArrowDown")).toBe(0);
    expect(nextMark(marks, null, "ArrowUp")).toBe(4);
    expect(nextMark(marks, 2, "ArrowDown")).toBe(3);
    expect(nextMark(marks, 3, "ArrowDown")).toBe(4);
    expect(nextMark(marks, 4, "ArrowUp")).toBe(3);
    expect(nextMark(marks, 2, "ArrowRight")).toBe(3);
    expect(nextMark(marks, 4, "ArrowRight")).toBe(4);
    expect(nextMark(marks, 0, "ArrowLeft")).toBe(0);
    expect(nextMark([], null, "ArrowDown")).toBeNull();
  });
});

describe("the text alternative", () => {
  it("names the chart, describes it with the caption and a table of the same numbers", () => {
    const { container } = render(<BarChart width={640} {...barProps} />);
    const el = container.querySelector("svg[data-chart]")!;
    expect(screen.getByRole("img", { name: `${METRIC} by station. Regenerative Monte Carlo` })).toBe(el);
    const ids = el.getAttribute("aria-describedby")!.split(" ");
    expect(container.ownerDocument.getElementById(ids[0])!.textContent).toBe("Five stations.");
    const table = container.ownerDocument.getElementById(ids[1]) as HTMLTableElement;
    expect(table.tagName).toBe("TABLE");
    expect(table.caption!.textContent).toBe(`${METRIC} by station`);
    expect([...table.tHead!.rows[0].cells].map((c) => c.textContent)).toEqual(["Station", "Regen MC (customers)"]);
    const s1 = regen.measurements.find((m) => m.metric === METRIC && typeof m.customerClass !== "number")!;
    const ci = interval(s1)!;
    expect([...table.tBodies[0].rows[0].cells].map((c) => c.textContent)).toEqual(["S1", `${fmt(s1.estimate)} (${fmt(ci.low)} to ${fmt(ci.high)})`]);
    expect(table.tBodies[0].rows).toHaveLength(5);
  });

  it("marks the reference and the gaps in a comparison's table, and lists a sweep by x", () => {
    const rows: DotRow[] = [...dotRows.slice(0, 1), { key: "x", label: "S9", values: [{ series: "qna", value: 1 }] }];
    const dots = render(<DotInterval width={720} {...dotProps} rows={rows} />);
    const t = dots.container.querySelector("[data-chart-table]") as HTMLTableElement;
    expect([...t.tBodies[0].rows[0].cells].map((c) => c.textContent)[1]).toBe(`${fmt(9.000001)}, reference`);
    expect([...t.tBodies[0].rows[1].cells].map((c) => c.textContent)).toEqual(["S9", "—", "—", "1.000"]);
    dots.unmount();
    const line = render(<LineChart width={640} {...lineProps} />);
    const lt = line.container.querySelector("[data-chart-table]") as HTMLTableElement;
    expect([...lt.tBodies[0].rows].map((r) => r.cells[0].textContent)).toEqual(["0.5", "0.7", "0.9"]);
    expect(lt.tBodies[0].rows[1].cells[2].textContent).toBe("—");
    expect(lt.tBodies[0].rows[0].cells[1].textContent).toBe("1.000 (0.800 to 1.200)");
  });
});

describe("chartSvgString", () => {
  it("serialises a standalone SVG in the light colours on white, with nothing left to resolve", () => {
    document.documentElement.dataset.theme = "dark";
    try {
      const { container } = render(<DotInterval width={720} {...dotProps} />);
      fireEvent.keyDown(container.querySelector("svg")!, { key: "ArrowDown" });
      expect(container.querySelector("[data-readout]")).not.toBeNull();
      const text = chartSvgString(container)!;
      expect(text.startsWith("<svg")).toBe(true);
      expect(text.endsWith("</svg>")).toBe(true);
      expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(text).not.toMatch(/var\(/);
      expect(text).not.toMatch(/--[a-z]/);
      expect(text).not.toMatch(/\b(class|tabindex|role|aria-[a-z]+|data-[a-z-]+)=/);
      // The light theme's tier colours and text, whatever the app shows; white behind.
      expect(text).toContain('fill="#2b5fd9"');
      expect(text).toContain('stroke="#0b8fa3"');
      expect(text).toContain('fill="#13161b"');
      // The drawing's 720 px plus a 16-pt margin of paper all round.
      expect(text).toMatch(/^<svg[^>]*><rect width="752" height="\d+" fill="#ffffff"\/><g transform="translate\(16,16\)">/);
      expect(text).toMatch(/^<svg[^>]*width="752"[^>]*viewBox="0 0 752 \d+"/);
      // The font the diagram export embeds; the title; no read-out, hit targets or focus mark.
      expect(text).toContain("font-family=\"-apple-system, BlinkMacSystemFont, &quot;SF Pro Text&quot;, system-ui, sans-serif\"");
      expect(text).toContain(`>${METRIC}: every method</text>`);
      expect(text).not.toContain("transparent");
      expect(text).not.toContain("#2a80e2");
      // It parses as XML.
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      expect(doc.querySelector("parsererror")).toBeNull();
      expect(doc.documentElement.querySelectorAll("text").length).toBeGreaterThan(10);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it("keeps a hatch pattern and its reference together, and answers null where there is no chart", () => {
    const { container } = render(<BarChart width={640} {...barProps} rows={classRows(multi)} series={classSeries} />);
    const text = chartSvgString(container.querySelector("svg"))!;
    const id = /<pattern id="([^"]+)"/.exec(text)![1];
    expect(text).toContain(`fill="url(#${id})"`);
    expect(text).not.toMatch(/var\(/);
    expect(chartSvgString(document.createElement("div"))).toBeNull();
    expect(chartSvgString(null)).toBeNull();
  });

  it("resolves tokens with a fallback and refuses one the stylesheet lacks", () => {
    expect(resolveTokens('<rect fill="var(--series-2)" stroke="var( --tier-bound , red)"/>')).toBe('<rect fill="#d9591f" stroke="#84480a"/>');
    expect(() => resolveTokens('<rect fill="var(--no-such-token)"/>')).toThrow();
  });
});

describe("the frame, the legend and the shapes", () => {
  it("measures its own element with its own window's ResizeObserver and hands the chart its width", async () => {
    const seen: number[] = [];
    const { container } = render(
      <ChartFrame>
        {({ width, fontScale }) => {
          seen.push(width);
          return <BarChart width={width} fontScale={fontScale} {...barProps} />;
        }}
      </ChartFrame>,
    );
    await act(async () => {});
    const el = container.querySelector("svg[data-chart]")!;
    expect(Number(el.getAttribute("width"))).toBe(seen[seen.length - 1]);
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(280);
  });

  it("draws in a detached window's document through that window's observer", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow as Window & typeof globalThis;
    const observed: Element[] = [];
    win.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push(target);
        this.cb([{ target, contentRect: { width: 512, height: 300 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const host = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement("div"));
    const view = render(<ChartFrame>{({ width }) => <BarChart width={width} {...barProps} />}</ChartFrame>, { container: host });
    await act(async () => {});
    expect(observed).toHaveLength(1);
    expect(observed[0].ownerDocument).toBe(frame.contentDocument);
    expect(host.querySelector("svg[data-chart]")).toHaveAttribute("width", "512");
    expect(chartSvgString(host)).toMatch(/^<svg[^>]*width="544"/);
    view.unmount();
    frame.remove();
  });

  it("wraps the legend at the chart's width", () => {
    const one = legendLayout(legend, 900);
    expect(new Set(one.items.map((i) => i.y)).size).toBe(1);
    const narrow = legendLayout(legend, 200);
    expect(new Set(narrow.items.map((i) => i.y)).size).toBeGreaterThan(1);
    expect(narrow.height).toBeGreaterThan(one.height);
    for (const it of narrow.items) expect(it.x).toBeGreaterThanOrEqual(0);
    expect(legendLayout([], 200).height).toBe(0);
  });

  it("gives each shape its own outline and cuts a long label with an ellipsis", () => {
    const paths = (["circle", "diamond", "square", "triangle", "cross"] as const).map((s) => shapePath(s, 10, 10, 4));
    expect(new Set(paths).size).toBe(5);
    for (const p of paths) expect(p).toMatch(/^M[-\d.,a-zA-Z ]+Z$/);
    expect(fitText("Station", 200, 11)).toBe("Station");
    const cut = fitText("A very long station name indeed", 60, 11);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(20);
  });
});
