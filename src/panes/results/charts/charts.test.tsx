// The Results pane's Charts view against the preview's replay of 0.90.34's runs (golden/runs/):
// what each chart is built from, the pane's switch and its empty states, the stale mark and the
// export (ledger VIZ-013…VIZ-024).
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { diagramCalls } from "../../../dev/mock/export";
import { defaultHandlers } from "../../../dev/mockBackend";
import { editorFor } from "../../../editor";
import { displayFixed } from "../../../editor/numbers";
import { getCommand, runCommand } from "../../../lib/commands";
import { getStateValue, loadKv, setStateValues } from "../../../lib/kv";
import { agreement, currentRuns, interval } from "../../../results/insight";
import { onRunFinished, startRun } from "../../../runs/state";
import { extendMock, mockTauri } from "../../../test/tauri";
import { addTab, getWorkspace } from "../../../workspace/store";
import type { ResultRecord } from "../model";
import { RESULTS_VIEW_KEY, ResultsPane } from "../ResultsPane";
import { percent } from "./ChartsView";
import { chartableRun, methodsChart, methodsMetrics, pickMetric, runChart, runMetrics } from "./data";
import { chartFileName, formatOf } from "./exportChart";

const examples = import.meta.glob("../../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const records = import.meta.glob("../../../../golden/runs/{5stationtandem.inf,3d2ctandem.inf}/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const golden = (example: string, method: string) => JSON.parse(records[`../../../../golden/runs/${example}/${method}/record.json`]) as ResultRecord;
const all = (example: string) => Object.entries(records).filter(([k]) => k.includes(`/${example}/`)).map(([, t]) => JSON.parse(t) as ResultRecord);

const fmt = (x: number) => displayFixed(x, 6);
const N = "Mean number in system";

describe("one run's chart", () => {
  it("offers the run's own per-station quantities and opens on Mean number in system", () => {
    const qna = golden("5stationtandem.inf", "qna");
    const list = runMetrics(qna);
    expect(list.map((o) => `${o.metric} (${o.unit})`)).toEqual(["Utilization (ratio)", "Mean number in system (customers)", "Throughput (customers / time)", "Mean sojourn time (time)"].sort((a, b) => list.findIndex((o) => `${o.metric} (${o.unit})` === a) - list.findIndex((o) => `${o.metric} (${o.unit})` === b)));
    expect(list).toHaveLength(4);
    expect(pickMetric(list, null)!.metric).toBe(N);
    expect(pickMetric(list, "Utilization|ratio")!.metric).toBe("Utilization");
    expect(pickMetric(list, "Gone|x")!.metric).toBe(N);
    // A method without that quantity opens on its first.
    const lp = golden("5stationtandem.inf", "lp");
    expect(pickMetric(runMetrics(lp), null)!.metric).toBe("Mean reported occupancy");
    expect(pickMetric([], null)).toBeNull();
  });

  it("is one bar per station in the tier's colour, with the unit on the axis and no interval for an approximation", () => {
    const qna = golden("5stationtandem.inf", "qna");
    const chart = runChart(qna, pickMetric(runMetrics(qna), null)!, fmt, false)!;
    expect(chart.rows.map((r) => r.label)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(chart.series).toEqual([{ key: "value", label: "QNA", color: "--tier-approximation" }]);
    const ms = qna.measurements.filter((m) => m.metric === N);
    expect(chart.rows.map((r) => r.values[0]!.value)).toEqual(ms.map((m) => m.estimate));
    expect(chart.rows.every((r) => r.values[0]!.interval === null)).toBe(true);
    expect(chart.title).toBe("Mean number in system by station");
    expect(chart.subtitle).toBe(`${qna.method.displayName} · Approximation`);
    expect(chart.axisLabel).toBe("Mean number in system (customers)");
    expect(chart.unit).toBe("customers");
    expect(chart.caption).toBe(`Mean number in system at 5 stations, from ${qna.method.displayName} (Approximation).`);
  });

  it("carries the simulation's intervals, uses the all-classes value of a one-class run, and names the highest", () => {
    const regen = golden("5stationtandem.inf", "regenerative_mc");
    const chart = runChart(regen, pickMetric(runMetrics(regen), null)!, fmt, false)!;
    expect(chart.series).toHaveLength(1);
    expect(chart.series[0].color).toBe("--tier-simulation");
    const whole = regen.measurements.filter((m) => m.metric === N && typeof m.customerClass !== "number");
    expect(chart.rows.map((r) => r.values[0])).toEqual(whole.map((m) => ({ value: m.estimate, interval: interval(m) })));
    expect(chart.rows.every((r) => r.values[0]!.interval)).toBe(true);
    const top = whole.reduce((a, b) => (b.estimate > a.estimate ? b : a));
    expect(chart.caption).toBe(
      `Mean number in system at 5 stations, from ${regen.method.displayName} (Simulation (95 % interval)). Highest: ${top.stationName} with ${fmt(top.estimate)} customers. The whiskers are each value's interval.`,
    );
  });

  it("groups a bar per customer class when the run has more than one, hatching every second", () => {
    const regen = golden("3d2ctandem.inf", "regenerative_mc");
    const chart = runChart(regen, pickMetric(runMetrics(regen), null)!, fmt, false)!;
    expect(chart.series).toEqual([
      { key: "class-0", label: "Class 1", color: "--series-1", hatched: false },
      { key: "class-1", label: "Class 2", color: "--series-2", hatched: true },
    ]);
    expect(chart.rows).toHaveLength(3);
    for (const row of chart.rows) {
      for (const c of [0, 1]) {
        const m = regen.measurements.find((x) => x.metric === N && x.stationID === row.key && x.customerClass === c)!;
        expect(row.values[c]).toEqual({ value: m.estimate, interval: interval(m) });
      }
    }
    expect(chart.caption).toContain("one bar per customer class (2 classes)");
    // A quantity the run reports for all classes only stays one series.
    const util = runChart(regen, runMetrics(regen).find((o) => o.metric === "Server utilization")!, fmt, false)!;
    expect(util.series).toHaveLength(1);
  });

  it("says so when the network has changed since the run, and has nothing for a run without measurements", () => {
    const qna = golden("5stationtandem.inf", "qna");
    const chart = runChart(qna, pickMetric(runMetrics(qna), null)!, fmt, true)!;
    expect(chart.subtitle).toBe(`${qna.method.displayName} · Approximation · network changed since this run`);
    expect(chart.caption.endsWith("The network has changed since this run.")).toBe(true);
    const failed = golden("5stationtandem.inf", "bar_bounds");
    expect(chartableRun(failed)).toBe(false);
    expect(runMetrics(failed)).toEqual([]);
    expect(chartableRun(golden("5stationtandem.inf", "regenerative_mc"))).toBe(true);
    expect(runChart(qna, { key: "x|y", metric: "x", unit: "y" }, fmt, false)).toBeNull();
  });
});

describe("the all-methods chart", () => {
  const runs = currentRuns(all("5stationtandem.inf"), null);
  const read = agreement(runs);

  it("puts every method that reports the quantity on each station's row, by tier, the reference marked", () => {
    const option = pickMetric(methodsMetrics(read), null)!;
    expect(option.metric).toBe(N);
    const chart = methodsChart(read, option, fmt, percent)!;
    expect(chart.rows.map((r) => r.label)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    const reporting = runs.filter((r) => r.measurements.some((m) => m.metric === N && m.unit === "customers"));
    expect(chart.series.map((s) => s.label)).toEqual(reporting.map((r) => r.method.shortName));
    expect(chart.series[0]).toMatchObject({ label: "Product Form", color: "--tier-exact", shape: "circle" });
    expect(chart.series.find((s) => s.label === "Monte Carlo")).toMatchObject({ color: "--tier-simulation", shape: "diamond" });
    expect(chart.series.find((s) => s.label === "QNA")).toMatchObject({ color: "--tier-approximation", shape: "square" });
    expect(chart.series.find((s) => s.label === "Spectral")).toMatchObject({ color: "--tier-diffusion", shape: "triangle" });
    for (const row of chart.rows) {
      expect(row.values.filter((x) => x.reference)).toHaveLength(1);
      const ref = row.values.find((x) => x.reference)!;
      expect(chart.series.find((s) => s.key === ref.series)!.label).toBe("Product Form");
      expect(ref.note).toBeUndefined();
      expect(row.values).toHaveLength(chart.series.length);
    }
    // The simulation keeps its interval; a deviation is said in words.
    const q = read.quantities.find((x) => x.metric === N && x.stationName === "S1" && x.classLabel === "All")!;
    const sim = q.values.find((x) => x.shortName === "Monte Carlo")!;
    const drawn = chart.rows[0].values.find((x) => x.series === sim.runId)!;
    expect(drawn.interval).toEqual(sim.interval);
    expect(drawn.note).toBe(`${percent(sim.deviation!)} ${sim.deviation! > 0 ? "above" : "below"} the reference`);
    expect(chart.legend.map((l) => l.label)).toEqual(["Exact", "Simulation (95 % interval)", "Approximation", "Diffusion model", "Reference: the value the others are measured against"]);
    expect(chart.subtitle).toBe(`${chart.series.length} methods · reference: Product Form (exact)`);
    expect(chart.caption).toMatch(new RegExp(`^Mean number in system from ${chart.series.length} methods at 5 stations, each with its interval where the method gives one\\. The methods (agree|are close|disagree) `));
  });

  it("leaves a class's row out when only one method reports it beside the all-classes row", () => {
    const option = pickMetric(methodsMetrics(read), null)!;
    expect(read.quantities.some((q) => q.metric === N && q.classLabel !== "All")).toBe(true);
    expect(methodsChart(read, option, fmt, percent)!.rows.every((r) => !r.label.includes("class"))).toBe(true);
  });

  it("with one method, draws it alone with no verdict, and with none has no chart", () => {
    const only = agreement([golden("5stationtandem.inf", "qna")]);
    const chart = methodsChart(only, pickMetric(methodsMetrics(only), null)!, fmt, percent)!;
    expect(chart.series).toHaveLength(1);
    expect(chart.subtitle).toBe("1 method · no exact result or simulation to measure against");
    expect(chart.caption).toBe("Mean number in system from 1 method at 5 stations, each with its interval where the method gives one.");
    expect(chart.legend.map((l) => l.label)).toEqual(["Approximation"]);
    const none = agreement([]);
    expect(methodsMetrics(none)).toEqual([]);
    expect(methodsChart(none, { key: "a|b", metric: "a", unit: "b" }, fmt, percent)).toBeNull();
  });
});

// ── The pane ──────────────────────────────────────────────────────────────────────────────────

function openExample(stem: string): string {
  let id = "";
  act(() => {
    id = addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: { infiniteBuffers: true, canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../../../examples/${stem}.bnet`]) } });
  });
  return id;
}

async function run(id: string, method: string) {
  const done = new Promise<void>((resolve) => {
    const stop = onRunFinished(() => {
      stop();
      resolve();
    });
  });
  await act(async () => {
    expect(await startRun(id, method)).toBe(true);
    await done;
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const viewButton = (name: string) => within(screen.getByRole("radiogroup", { name: "Results view" })).getByRole("radio", { name });
const scopeButton = (name: string) => within(screen.getByRole("radiogroup", { name: "What the chart shows" })).getByRole("radio", { name });
const chart = () => document.querySelector("svg[data-chart]");
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(async () => {
  mockTauri(defaultHandlers());
  await loadKv();
  diagramCalls.length = 0;
});

describe("the pane's Charts view", () => {
  it("keeps the table until the tab has a completed run, then offers Charts and remembers the choice", async () => {
    const id = openExample("5stationtandem.inf");
    const first = render(<ResultsPane />);
    await settle();
    expect(viewButton("Table")).toHaveAttribute("aria-checked", "true");
    expect(viewButton("Charts")).toBeDisabled();
    expect(viewButton("Charts")).toHaveAttribute("title", "Charts are offered once a run on this tab has completed");
    await run(id, "qna");
    await waitFor(() => expect(viewButton("Charts")).toBeEnabled());
    expect(viewButton("Table")).toHaveAttribute("aria-checked", "true");
    expect(chart()).toBeNull();
    fireEvent.click(viewButton("Charts"));
    await settle();
    expect(viewButton("Charts")).toHaveAttribute("aria-checked", "true");
    expect(chart()).toHaveAttribute("data-chart", "bar");
    expect(screen.getByRole("img", { name: /^Mean number in system by station\. .* · Approximation$/ })).toBeInTheDocument();
    expect(document.querySelector(".results-split")).toHaveAttribute("hidden");
    expect(getStateValue(RESULTS_VIEW_KEY, "table")).toBe("charts");
    // A pane mounted later (a relaunch, a detached window) opens on the remembered view.
    first.unmount();
    render(<ResultsPane />);
    await settle();
    expect(viewButton("Charts")).toHaveAttribute("aria-checked", "true");
    expect(chart()).not.toBeNull();
    fireEvent.click(viewButton("Table"));
    expect(chart()).toBeNull();
    expect(getStateValue(RESULTS_VIEW_KEY, "charts")).toBe("table");
  });

  it("falls back to the table on a tab with no completed run, even when Charts is remembered", async () => {
    await act(() => setStateValues({ [RESULTS_VIEW_KEY]: "charts" }));
    openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await settle();
    expect(viewButton("Table")).toHaveAttribute("aria-checked", "true");
    expect(viewButton("Charts")).toBeDisabled();
    expect(screen.getByText("No Results Yet")).toBeInTheDocument();
    expect(document.querySelector(".results-charts")).toBeNull();
  });

  it("charts the chosen run and quantity, with the app's decimals", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await run(id, "qna");
    await run(id, "regenerative_mc");
    fireEvent.click(await waitFor(() => viewButton("Charts")));
    await settle();
    const runPicker = screen.getByRole("combobox", { name: "Run to chart" }) as HTMLSelectElement;
    expect([...runPicker.options].map((o) => o.textContent!.split(" · ")[0]).sort()).toEqual(["QNA", "Regen MC"]);
    fireEvent.change(runPicker, { target: { value: [...runPicker.options].find((o) => o.textContent!.startsWith("Regen"))!.value } });
    const metric = screen.getByRole("combobox", { name: "Quantity to chart" }) as HTMLSelectElement;
    expect(metric.selectedOptions[0].textContent).toBe("Mean number in system (customers)");
    expect(document.querySelectorAll("[data-whisker]")).toHaveLength(5);
    const qna = [...runPicker.options].find((o) => o.textContent!.startsWith("QNA"))!;
    fireEvent.change(runPicker, { target: { value: qna.value } });
    expect(document.querySelectorAll("[data-whisker]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-bar]")).toHaveLength(5);
    expect([...document.querySelectorAll("[data-value-label]")].map((n) => n.textContent)).toEqual(golden("5stationtandem.inf", "qna").measurements.filter((m) => m.metric === N).map((m) => displayFixed(m.estimate, 6)));
    fireEvent.change(metric, { target: { value: "Utilization|ratio" } });
    expect(document.querySelector("[data-chart-title]")!.textContent).toBe("Utilization by station");
    expect(document.querySelector("[data-axis-label]")!.textContent).toBe("Utilization (ratio)");
    expect(document.querySelector(".chart-caption")!.textContent).toMatch(/^Utilization at 5 stations, from /);
  });

  it("All Methods: one method says a second would show how sure to be, with a button; two are drawn together", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await run(id, "qna");
    fireEvent.click(await waitFor(() => viewButton("Charts")));
    fireEvent.click(scopeButton("All Methods"));
    await settle();
    expect(chart()).toHaveAttribute("data-chart", "dot-interval");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Only one method has run on this network. A second method would show how sure to be.");
    expect(within(note).getByRole("button", { name: "Check with Another Method" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Run to chart" })).toBeNull();
    await run(id, "product_form");
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    expect(document.querySelectorAll("[data-dot]")).toHaveLength(10);
    expect(document.querySelectorAll("[data-reference-mark]")).toHaveLength(5);
    expect([...document.querySelectorAll("[data-legend-item]")].map((n) => n.textContent)).toEqual(["Exact", "Approximation", "Reference: the value the others are measured against"]);
    expect([...new Set([...document.querySelectorAll("[data-lane-label]")].map((n) => n.textContent))]).toEqual(["Product Form", "QNA"]);
    expect(document.querySelector(".chart-caption")!.textContent).toMatch(/The methods agree \(within 2 %\)\.$/);
  });

  it("marks a stale run as the table does, and leaves it out of All Methods with a way forward", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await run(id, "qna");
    fireEvent.click(await waitFor(() => viewButton("Charts")));
    await settle();
    const view = within(document.querySelector(".results-charts") as HTMLElement);
    expect(view.queryByText("Network changed")).toBeNull();
    const editor = editorFor(id);
    // A change a solver reads; moving a node alone no longer makes a run stale (src/results/current.ts).
    const node = editor.nodes.find((n) => n.kind === "station")!;
    await act(async () => {
      editor.updateNumberOfServers(node.id, 2);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(view.getByText("Network changed")).toBeInTheDocument());
    expect(view.getByText("Network changed").closest(".results-chip")).toHaveAttribute("title", "This result remains valid for its saved network snapshot, but the current canvas no longer matches it.");
    expect(document.querySelector("[data-chart-subtitle]")!.textContent).toMatch(/ · network changed since this run$/);
    expect((screen.getByRole("combobox", { name: "Run to chart" }) as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/ · network changed$/);
    fireEvent.click(scopeButton("All Methods"));
    expect(chart()).toBeNull();
    expect(screen.getByRole("heading", { name: "The Network Changed" })).toBeInTheDocument();
    expect(screen.getByText("1 earlier run belongs to the network as it was. Run a method again to chart the network as it is now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Solve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Chart…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy Chart" })).toBeDisabled();
  });

  it("says there is nothing to chart for a tab whose only finished runs have no per-station numbers", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await run(id, "qna");
    await run(id, "bar_bounds");
    fireEvent.click(await waitFor(() => viewButton("Charts")));
    await settle();
    // The failed run is not offered; the completed one is charted.
    expect([...(screen.getByRole("combobox", { name: "Run to chart" }) as HTMLSelectElement).options]).toHaveLength(1);
    expect(chart()).not.toBeNull();
  });
});

describe("Export Chart… and Copy Chart", () => {
  async function showing(): Promise<string> {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await run(id, "regenerative_mc");
    fireEvent.click(await waitFor(() => viewButton("Charts")));
    await settle();
    return id;
  }
  const lastStatus = (id: string) => getWorkspace().tabs.find((t) => t.id === id)!.log.at(-1)!.text;

  it("names the file after the document and reads the format from the chosen name", () => {
    const id = openExample("5stationtandem.inf");
    expect(chartFileName(id)).toBe("5stationtandem.inf Chart");
    expect(chartFileName(getWorkspace().tabs[0].id)).toBe("Network Chart");
    expect(formatOf("/a/b.PNG")).toBe("png");
    expect(formatOf("/a/b.svg")).toBe("svg");
    expect(formatOf("/a/b.pdf")).toBe("pdf");
    expect(formatOf("/a/b")).toBe("pdf");
  });

  it("writes a PDF or PNG through the diagram export, light on white whatever the theme", async () => {
    const id = await showing();
    document.documentElement.dataset.theme = "dark";
    const asked: Record<string, unknown>[] = [];
    try {
      for (const ext of ["pdf", "png"]) {
        extendMock({
          "plugin:dialog|save": ({ options }: { options: Record<string, unknown> }) => {
            asked.push(options);
            return `/out/fig.${ext}`;
          },
        });
        await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Chart…" })));
        await settle();
        const call = diagramCalls.at(-1)!;
        expect(call.cmd).toBe("diagram_export");
        expect(call.args).toMatchObject({ format: ext, path: `/out/fig.${ext}`, scale: 2 });
        const svg = call.args.svg as string;
        expect(svg).not.toMatch(/var\(/);
        expect(svg).toContain('fill="#ffffff"');
        expect(svg).toContain('fill="#0b8fa3"');
        expect(svg).toContain(">Mean number in system by station</text>");
        expect(lastStatus(id)).toBe(`Exported chart to fig.${ext}.`);
      }
    } finally {
      delete document.documentElement.dataset.theme;
    }
    expect(asked[0]).toMatchObject({ title: "Export Chart", defaultPath: "5stationtandem.inf Chart.pdf" });
    expect((asked[0].filters as { extensions: string[] }[]).map((f) => f.extensions[0])).toEqual(["pdf", "png", "svg"]);
  });

  it("writes an SVG as text, does nothing when the panel is cancelled, and reports a failed write", async () => {
    const id = await showing();
    const written: Record<string, string> = {};
    extendMock({
      "plugin:dialog|save": () => "/out/fig.svg",
      export_save: ({ path, text }: { path: string; text: string }) => {
        written[path] = text;
        return "fig.svg";
      },
    });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Chart…" })));
    await settle();
    expect(diagramCalls).toHaveLength(0);
    expect(written["/out/fig.svg"]).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(written["/out/fig.svg"]).not.toMatch(/var\(/);
    expect(lastStatus(id)).toBe("Exported chart to fig.svg.");

    const before = getWorkspace().tabs.find((t) => t.id === id)!.log.length;
    extendMock({ "plugin:dialog|save": () => null });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Chart…" })));
    await settle();
    expect(getWorkspace().tabs.find((t) => t.id === id)!.log).toHaveLength(before);

    extendMock({ "plugin:dialog|save": () => "/read-only/fig.pdf" });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Chart…" })));
    await settle();
    expect(lastStatus(id)).toBe("!! Could not write fig.pdf: Permission denied (os error 13)");
  });

  it("copies the chart as the canvas's Copy as Image does, from the toolbar, the Export menu and the palette", async () => {
    const id = await showing();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy Chart" })));
    await settle();
    expect(diagramCalls.at(-1)!.cmd).toBe("diagram_copy");
    const args = diagramCalls.at(-1)!.args as { pdfSvg: string; imageSvg: string; scale: number };
    expect(args.pdfSvg).toBe(args.imageSvg);
    expect(args.pdfSvg).not.toMatch(/var\(/);
    expect(args.scale).toBe(2);
    expect(lastStatus(id)).toBe("Copied the chart to the clipboard as PDF and TIFF.");

    fireEvent.click(screen.getByRole("button", { name: "Export results" }));
    const menu = screen.getByRole("menu", { name: "Export results" });
    expect(within(menu).getByRole("menuitem", { name: "Export Chart…" })).not.toHaveAttribute("aria-disabled");
    await act(async () => void fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy Chart" })));
    await settle();
    expect(diagramCalls.filter((c) => c.cmd === "diagram_copy")).toHaveLength(2);

    expect(getCommand("results:export-chart")!.title).toBe("Export Chart…");
    await act(async () => void (await runCommand("results:copy-chart")));
    expect(diagramCalls.filter((c) => c.cmd === "diagram_copy")).toHaveLength(3);
    // In the Table view the menu is the table's own and the palette's chart commands are gone.
    fireEvent.click(viewButton("Table"));
    fireEvent.click(screen.getByRole("button", { name: "Export results" }));
    expect(within(screen.getByRole("menu", { name: "Export results" })).queryByRole("menuitem", { name: "Export Chart…" })).toBeNull();
    expect(getCommand("results:export-chart")).toBeUndefined();
  });
});
