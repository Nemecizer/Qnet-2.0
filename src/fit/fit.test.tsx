// Fit from Data… (new in 2.1, ROADMAP D2): reading numbers out of pasted text, what stops a fit,
// the panel against the mock backend's recorded answers (which a Rust test keeps equal to what
// `fit_distribution` returns), and "Use This Distribution" as one undo step through the inspector.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fitCase, MOCK_DATA_FILE, mockFit } from "../dev/mock/fit";
import { defaultHandlers } from "../dev/mockBackend";
import { editorClock } from "../editor";
import { loadKv, resetKv } from "../lib/kv";
import { resetOverlays } from "../lib/overlays";
import { InspectorPane } from "../panes/inspector";
import { nodeNamed, openExample } from "../panes/inspector/testing";
import { extendMock, mockCalls, mockTauri } from "../test/tauri";
import { comparisons, curveAt } from "./charts";
import { dataProblem, FitHost, lawText, pText } from "./FitPanel";
import { candidatesOf, defaultChoice } from "./model";
import { cellNumber, defaultColumn, parseData, prepare } from "./parse";
import { EXAMPLE_TEXT, EXAMPLE_VALUES } from "./sample";
import { closeFitPanel, currentFitPanel } from "./store";
import { fitWords as w } from "./words";

const WAIT = { timeout: 8000 };

describe("reading the numbers", () => {
  it("reads a list separated by new lines, commas, tabs, semicolons or spaces", () => {
    for (const text of ["1.5\n2\n3.25", "1.5, 2, 3.25", "1.5\t2\t3.25", "1.5;2;3.25", "  1.5  2 3.25 ", "1.5,2\n3.25", "﻿1.5\r\n2\r\n3.25\r\n"]) {
      const p = parseData(text);
      expect(p.columns, JSON.stringify(text)).toHaveLength(1);
      expect(p.columns[0].values, JSON.stringify(text)).toEqual([1.5, 2, 3.25]);
      expect(p.columns[0].skipped).toEqual([]);
    }
    expect(parseData("1e-2 .5 +3 -4. −2").columns[0].values).toEqual([0.01, 0.5, 3, -4, -2]);
    expect(parseData("").columns).toEqual([]);
  });

  it("leaves out cells that are not numbers and says which", () => {
    const p = parseData("0.4\nn/a\n1.2\n—\n3.1e\n2");
    expect(p.columns[0].values).toEqual([0.4, 1.2, 2]);
    expect(p.columns[0].skipped).toEqual(["n/a", "—", "3.1e"]);
    expect(w.skipped(p.columns[0].skipped)).toBe("3 cells that are not numbers were left out (“n/a”, “—”, “3.1e”).");
    expect(w.skipped(["x"])).toBe("1 cell that is not a number was left out (“x”).");
    expect(cellNumber("Infinity", false)).toBeNull();
    expect(cellNumber("0x10", false)).toBeNull();
    expect(cellNumber('"2.5"', false)).toBe(2.5);
  });

  it("finds a table's columns and their headings, and opens on the last full one", () => {
    const p = parseData("id,service,note\n1,0.5,ok\n2,0.7,ok\n3,,late\n4,1.1,ok");
    expect(p.table).toBe(true);
    expect(p.columns.map((c) => [c.header, c.values.length, c.skipped.length])).toEqual([
      ["id", 4, 0],
      ["service", 3, 0],
      [null, 0, 5],
    ]);
    expect(defaultColumn(p)).toBe(0);
    const q = parseData(MOCK_DATA_FILE.text);
    expect(q.columns.map((c) => c.header)).toEqual(["customer", "arrival time"]);
    expect(defaultColumn(q)).toBe(1);
    expect(w.columnName(1, "arrival time", 41)).toBe("arrival time (41 numbers)");
    expect(w.columnName(0, null, 1)).toBe("Column 1 (1 number)");
  });

  it("takes a comma for a decimal mark only when nothing else can be meant", () => {
    // A semicolon or a tab already separates the cells: the comma is a decimal mark.
    const semi = parseData("1,5;2,25\n3,5;4,75");
    expect(semi.decimalComma).toBe(true);
    expect(semi.ambiguous).toBe(false);
    expect(semi.columns.map((c) => c.values)).toEqual([[1.5, 3.5], [2.25, 4.75]]);
    expect(parseData("0,5\t1,5\t2,5").columns[0].values).toEqual([0.5, 1.5, 2.5]);
    // A decimal point anywhere: commas separate.
    const mixed = parseData("1.5,2.5\n3.5,4.5");
    expect(mixed.decimalComma).toBe(false);
    expect(mixed.ambiguous).toBe(false);
    // "1,5" on every line could be either: separators, and the panel is told to ask.
    const either = parseData("1,5\n2,7\n3,1");
    expect(either.decimalComma).toBe(false);
    expect(either.ambiguous).toBe(true);
    expect(either.columns.map((c) => c.values)).toEqual([[1, 2, 3], [5, 7, 1]]);
    expect(parseData("1,5 2,7 3,1").ambiguous).toBe(true);
    // The switch settles it.
    const told = parseData("1,5\n2,7\n3,1", true);
    expect(told.ambiguous).toBe(false);
    expect(told.columns[0].values).toEqual([1.5, 2.7, 3.1]);
    expect(parseData("1,5 2,7 3,1", true).columns[0].values).toEqual([1.5, 2.7, 3.1]);
    // Three numbers in a row are never a decimal.
    expect(parseData("1,2,3").ambiguous).toBe(false);
    expect(parseData("1,2,3").columns[0].values).toEqual([1, 2, 3]);
    expect(parseData("1, 5\n2, 7").ambiguous).toBe(false);
  });

  it("turns event times into the gaps between them, in time order", () => {
    const p = prepare([10, 12.5, 12.5, 11, 20], { eventTimes: true, dropZeros: false });
    expect(p.data).toEqual([1, 1.5, 0, 7.5]);
    expect(p.sorted).toBe(true);
    expect(p.zeros).toBe(1);
    expect(p.negatives).toBe(0);
    expect(prepare([10, 12.5, 12.5, 11, 20], { eventTimes: true, dropZeros: true }).data).toEqual([1, 1.5, 7.5]);
    expect(prepare([1, 2, 4], { eventTimes: true, dropZeros: false }).sorted).toBe(false);
    const plain = prepare([3, -1, 0, 2], { eventTimes: false, dropZeros: false });
    expect([plain.data.length, plain.negatives, plain.zeros]).toEqual([4, 1, 1]);
    expect(w.gaps(41, 40, true)).toBe("41 event times, sorted into time order, give 40 gaps.");
  });

  it("says in a sentence what stops a fit", () => {
    const problem = (text: string, eventTimes = false) => {
      const parsed = parseData(text);
      const column = parsed.columns[defaultColumn(parsed)];
      return dataProblem(text, parsed, column ? prepare(column.values, { eventTimes, dropZeros: false }) : null, eventTimes);
    };
    expect(problem("  ")).toBe("Paste or load at least 10 measured times.");
    expect(problem("abc def")).toBe("Qnet found no numbers in the data.");
    expect(problem("1 2 3")).toBe("Qnet needs at least 10 observations to fit a distribution, and there are 3. With so few, even the mean is uncertain by a large factor.");
    expect(problem("1 2 3 4 5 6 7 8 9 10", true)).toMatch(/at least 10 gaps \(11 event times\) .* there are 9\./);
    expect(problem("1 2 3 4 5 -6 7 8 9 10")).toMatch(/^1 value is negative\. A service or inter-arrival time cannot be negative/);
    expect(problem("0 0 0 0 0 0 0 0 0 0")).toBe("Every value is zero, so there is no time to fit.");
    expect(problem("1 2 3 4 5 6 7 8 9 10")).toBeNull();
    expect(problem("1 2 3 4 5 6 7 8 9 10 11", true)).toBeNull();
  });
});

describe("the recorded answers the preview shows", () => {
  it("are for the example data and the preview's file, and hold together", () => {
    const service = fitCase("service");
    expect(service.data).toEqual([...EXAMPLE_VALUES]);
    const r = service.report;
    expect(r.summary.n).toBe(60);
    // The mean is the data's (a check on the recording, not a second computation of the fit).
    expect(r.summary.mean).toBeCloseTo(EXAMPLE_VALUES.reduce((a, b) => a + b, 0) / 60, 10);
    expect(r.summary.meanInterval[0]).toBeLessThan(r.summary.mean);
    expect(r.summary.meanInterval[1]).toBeGreaterThan(r.summary.mean);
    expect(r.histogram.counts.reduce((a, b) => a + b, 0)).toBe(60);
    // Ranked by AIC; what does not apply is last and says why.
    const aic = r.mle.filter((c) => c.applicable).map((c) => c.aic!);
    expect([...aic].sort((a, b) => a - b)).toEqual(aic);
    expect(r.mle.filter((c) => !c.applicable).every((c) => !!c.note)).toBe(true);
    expect(r.recommended).toBe("erlang");
    expect(defaultChoice(r, "mle")).toBe("erlang");
    // By moments the choice is the best family that takes both the mean and the SCV.
    const m = candidatesOf(r, "moments").find((c) => c.family === defaultChoice(r, "moments"))!;
    expect(m.matchesScv).toBe(true);
    expect(m.mean!).toBeCloseTo(r.summary.mean, 9);
    expect(m.scv!).toBeCloseTo(r.summary.scv, 7);
    // The gaps of the preview's file are the second sample.
    const gaps = fitCase("gaps");
    const fromFile = prepare(parseData(MOCK_DATA_FILE.text).columns[1].values, { eventTimes: true, dropZeros: false }).data;
    expect(fromFile).toHaveLength(40);
    expect(() => mockFit({ data: fromFile, kind: "source" })).not.toThrow();
    expect(gaps.report.mle.some((c) => c.family === "poisson")).toBe(true);
    // A station asking about the same numbers is offered Exponential, not a Poisson process.
    const asStation = mockFit({ data: fromFile, kind: "station" });
    expect(asStation.mle.find((c) => c.family === "exponential")!.parameters).toMatch(/^rate=/);
    expect(() => mockFit({ data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], kind: "station" })).toThrow();
  });

  it("are read between grid points for the charts' read-outs", () => {
    expect(curveAt([0, 1, 2], [0, 0.5, 1], 1.5)).toBe(0.75);
    expect(curveAt([0, 1, 2], [0, 0.5, 1], 0)).toBe(0);
    expect(curveAt([0, 1, 2], [0, 0.5, 1], 2.5)).toBeNull();
    expect(curveAt([0, 1, 2], [null, 0.5, 1], 0.5)).toBeNull();
    const r = fitCase("service").report;
    const chosen = r.mle.find((c) => c.family === "erlang")!;
    expect(comparisons(r.mle, chosen).map((c) => c.family)).toEqual(["gamma", "weibull"]);
    expect(pText(0.0004)).toBe("< 0.001");
    expect(pText(0.8359)).toBe("0.836");
    expect(lawText(chosen)).toMatch(/^Erlang \(Stages \(k\) = 3, Rate \(μ\) = 0\.7112\)$/);
  });
});

// ── The panel ───────────────────────────────────────────────────────────────────────────────────

const frames: HTMLIFrameElement[] = [];
let opened: { name: string; win: Window }[] = [];
let now = 1_000_000;

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetOverlays();
  now = 1_000_000;
  editorClock.now = () => now;
  opened = [];
  vi.spyOn(window, "open").mockImplementation((_url, target) => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frames.push(frame);
    const win = frame.contentWindow!;
    opened.push({ name: String(target), win });
    return win;
  });
});
afterEach(async () => {
  await act(async () => closeFitPanel());
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

const panel = () => {
  const o = [...opened].reverse().find((x) => x.name === "qnet-panel-fit-distribution");
  if (!o) throw new Error("no fit panel");
  return within(o.win.document.body);
};
const panelBody = () => [...opened].reverse().find((x) => x.name === "qnet-panel-fit-distribution")!.win.document.body;

function show(stem: string, node: string) {
  const e = openExample(stem);
  render(
    <>
      <InspectorPane />
      <FitHost />
    </>,
  );
  act(() => e.setView({ selectedNodeID: nodeNamed(e, node).id, selectedLinkID: null, selectedNodeIDs: new Set() }));
  return e;
}

async function openPanel() {
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Fit from Data…/ })));
  return panel();
}

describe("the Fit from Data panel", () => {
  it("opens from the inspector's distribution editor, empty, saying what to do", async () => {
    show("2dtandem", "S1");
    const p = await openPanel();
    expect(currentFitPanel()?.target).toBe("the Class 1 service time at S1");
    expect(p.getByText("Measured times for the Class 1 service time at S1")).toBeInTheDocument();
    expect(p.getByText("Paste or load at least 10 measured times.")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Use This Distribution" })).toBeDisabled();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Cancel" })));
    expect(currentFitPanel()).toBeNull();
  });

  it("draws itself in a root of its own when no host is mounted", async () => {
    const e = openExample("2dtandem");
    render(<InspectorPane />);
    act(() => e.setView({ selectedNodeID: nodeNamed(e, "S2").id, selectedLinkID: null, selectedNodeIDs: new Set() }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Fit from Data…/ })));
    await waitFor(() => expect(panel().getByText(/^Measured times for the .*service time at S2$/)).toBeInTheDocument(), WAIT);
  });

  it("refuses too few points and negative values with the reason, without asking for a fit", async () => {
    show("2dtandem", "S1");
    const p = await openPanel();
    const data = p.getByLabelText("Measured times");
    fireEvent.change(data, { target: { value: "1 2 3 x" } });
    expect(p.getByText("3 numbers read. 1 cell that is not a number was left out (“x”).")).toBeInTheDocument();
    expect(p.getAllByText(/Qnet needs at least 10 observations to fit a distribution, and there are 3\./).length).toBeGreaterThan(0);
    fireEvent.change(data, { target: { value: "1 2 3 4 5 6 -7 8 9 10 11" } });
    expect(p.getAllByText(/^1 value is negative\./).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(mockCalls.filter((c) => c.cmd === "fit_distribution")).toEqual([]);
    expect(p.getByRole("button", { name: "Use This Distribution" })).toBeDisabled();
  });

  it("fits the example data: summary, ranked candidates, the recommendation, both charts", async () => {
    show("2dtandem", "S1");
    const p = await openPanel();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Use Example Data" })));
    expect((p.getByLabelText("Measured times") as HTMLTextAreaElement).value).toBe(EXAMPLE_TEXT);
    await waitFor(() => expect(panelBody().querySelector("[data-fit-table]")).not.toBeNull(), WAIT);
    expect(mockCalls.filter((c) => c.cmd === "fit_distribution").at(-1)!.args).toEqual({ request: { data: [...EXAMPLE_VALUES], kind: "station" } });
    const r = fitCase("service").report;

    // The sample, with units and intervals.
    const summary = within(panelBody().querySelector<HTMLElement>("[data-fit-summary]")!);
    expect(summary.getByText("60")).toBeInTheDocument();
    expect(summary.getByText("4.219")).toBeInTheDocument();
    expect(summary.getByText("95 % interval 3.651 to 4.814")).toBeInTheDocument();
    expect(summary.getByText("0.3112")).toBeInTheDocument();
    expect(summary.getAllByText("time units").length).toBe(2);
    expect(summary.getByText("per time unit")).toBeInTheDocument();
    expect(p.getByText(/percentile bootstrap, 2,000 resamples/)).toBeInTheDocument();

    // The ranked table, best first, with the recommended family chosen.
    const rows = [...panelBody().querySelectorAll<HTMLElement>("[data-fit-table] tbody tr")];
    expect(rows.map((row) => row.dataset.family)).toEqual(r.mle.map((c) => c.family));
    expect(rows.map((row) => row.dataset.family).slice(0, 3)).toEqual(["gamma", "erlang", "weibull"]);
    const erlang = rows.find((row) => row.dataset.family === "erlang")!;
    expect(erlang.dataset.chosen).toBe("true");
    expect(within(erlang).getByText("Recommended")).toBeInTheDocument();
    expect(within(erlang).getByText("Stages (k) = 3, Rate (μ) = 0.7112")).toBeInTheDocument();
    expect(within(erlang).getByRole("radio", { name: "Use Erlang" })).toBeChecked();
    expect(p.getByText(/^Recommended: Erlang\. Gamma fits a little better, but not significantly so/)).toBeInTheDocument();
    // What cannot be fitted says why and cannot be chosen.
    const pareto = rows.find((row) => row.dataset.family === "pareto")!;
    expect(pareto.dataset.na).toBe("true");
    expect(pareto.textContent).toMatch(/Does not apply: The fitted shape is α = 0\.4047; Qnet holds a Pareto law only for α > 2/);
    expect(within(pareto).queryByRole("radio")).toBeNull();
    // The KS p-value is flagged as optimistic.
    expect(p.getByText(/KS p-values are approximate, and optimistic because the parameters were fitted to these same data\./)).toBeInTheDocument();
    expect(p.getByText(/Maximum likelihood uses the whole shape of the data/)).toBeInTheDocument();
    expect(p.getByText(/Qnet has no time units of its own/)).toBeInTheDocument();

    // Both charts: the data, the chosen family and two others, each with its table alternative.
    await waitFor(() => expect(panelBody().querySelectorAll("svg[data-chart]").length).toBe(2), WAIT);
    const density = panelBody().querySelector<SVGElement>('svg[data-chart="fit-density"]')!;
    expect(density.querySelectorAll("[data-bin]").length).toBe(r.histogram.counts.length);
    expect([...density.querySelectorAll("[data-curve]")].map((c) => c.getAttribute("data-curve")).sort()).toEqual(["erlang", "gamma", "weibull"]);
    expect(density.querySelector("[data-chosen]")!.getAttribute("stroke")).toBe("var(--series-2)");
    expect(density.querySelector("[data-bin]")!.getAttribute("fill")).toBe("var(--series-1)");
    const cdf = panelBody().querySelector<SVGElement>('svg[data-chart="fit-cdf"]')!;
    expect(cdf.querySelector("[data-ecdf]")!.getAttribute("stroke")).toBe("var(--series-1)");
    expect(cdf.getAttribute("aria-label")).toBe("Distribution function. Steps: the data. Line: Erlang.");
    const tables = panelBody().querySelectorAll("[data-chart-table]");
    expect(tables[0].querySelectorAll("tbody tr").length).toBe(r.histogram.counts.length);
    expect(tables[0].querySelector("thead")!.textContent).toBe("IntervalObservationsExpected under Erlang");
    expect(panelBody().textContent).toContain("The largest vertical gap between them is the KS distance, 0.07922.");
    // Every colour in the charts is a token.
    for (const el of panelBody().querySelectorAll("svg[data-chart] [fill], svg[data-chart] [stroke]")) {
      for (const a of ["fill", "stroke"]) {
        const val = el.getAttribute(a);
        if (val && val !== "none" && val !== "transparent" && !val.startsWith("url(")) expect(val, `${a} of ${el.tagName}`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      }
    }
  });

  it("matches the mean and SCV instead, and says which of Qnet's methods read only those", async () => {
    show("2dtandem", "S1");
    const p = await openPanel();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Use Example Data" })));
    await waitFor(() => expect(panelBody().querySelector("[data-fit-table]")).not.toBeNull(), WAIT);
    await act(async () => void fireEvent.click(p.getByRole("radio", { name: "Mean and SCV" })));
    expect(p.getByText(/QNA, RQNA, the diffusion \(SRBM\) methods and the bounds read only the mean and the SCV/)).toBeInTheDocument();
    expect(panelBody().querySelector("[data-fit-recommend]")).toBeNull();
    const rows = [...panelBody().querySelectorAll<HTMLElement>("[data-fit-table] tbody tr")];
    // Erlang's 1/k cannot be the data's SCV, so the choice opens on Gamma, which takes both moments.
    const gamma = rows.find((row) => row.dataset.family === "gamma")!;
    expect(gamma.dataset.chosen).toBe("true");
    expect(within(gamma).getByText("0.3112")).toBeInTheDocument();
    expect(rows.find((row) => row.dataset.family === "erlang")!.textContent).toMatch(/Matches the mean; the SCV is the nearest an Erlang law has, 1\/k = 0\.3333/);
    expect(rows.find((row) => row.dataset.family === "exponential")!.textContent).toMatch(/Matches the mean only: this family's SCV is always 1/);
  });

  it("applies the chosen distribution to the station as one undo step", async () => {
    const e = show("2dtandem", "S1");
    const before = { d: nodeNamed(e, "S1").distribution, p: nodeNamed(e, "S1").distributionParameters };
    const p = await openPanel();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Use Example Data" })));
    await waitFor(() => expect(panelBody().querySelector("[data-fit-table]")).not.toBeNull(), WAIT);
    await act(async () => void fireEvent.click(p.getByRole("radio", { name: "Use Gamma" })));
    expect(panelBody().querySelector("[data-fit-law]")!.textContent).toBe("Gamma (Shape (k) = 3.051, Scale (θ) = 1.383)");
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Use This Distribution" })));
    expect(currentFitPanel()).toBeNull();
    const fitted = fitCase("service").report.mle.find((c) => c.family === "gamma")!;
    await waitFor(() => expect(nodeNamed(e, "S1").distribution).toBe("gamma"), WAIT);
    // The parameters are the fitted ones, to the digits the inspector stores.
    const stored = Object.fromEntries(nodeNamed(e, "S1").distributionParameters.split(",").map((kv) => kv.split("=")).map(([k, x]) => [k, Number(x)]));
    expect(stored.shape).toBeCloseTo(fitted.params[0].value, 5);
    expect(stored.scale).toBeCloseTo(fitted.params[1].value, 5);
    expect((screen.getByRole("combobox", { name: "Distribution" }) as HTMLSelectElement).value).toBe("gamma");
    // One Undo takes the whole change back.
    act(() => e.undo());
    expect(nodeNamed(e, "S1").distribution).toBe(before.d);
    expect(nodeNamed(e, "S1").distributionParameters).toBe(before.p);
  });

  it("reads a chosen file, lets a column be chosen, and fits the gaps between event times", async () => {
    const e = show("MM1K.d1.c1.fin", "Src1");
    extendMock({ "plugin:dialog|open": () => "/data/arrivals.csv" });
    const p = await openPanel();
    expect(p.getByText("Measured times for the time between arrivals from Src1")).toBeInTheDocument();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Choose File…" })));
    await waitFor(() => expect((p.getByLabelText("Measured times") as HTMLTextAreaElement).value).toBe(MOCK_DATA_FILE.text), WAIT);
    expect(mockCalls.filter((c) => c.cmd === "fit_read_file").at(-1)!.args).toEqual({ path: "/data/arrivals.csv" });
    const column = p.getByLabelText("Column") as HTMLSelectElement;
    expect([...column.options].map((o) => o.textContent)).toEqual(["customer (41 numbers)", "arrival time (41 numbers)"]);
    expect(column.selectedOptions[0].textContent).toBe("arrival time (41 numbers)");
    expect(p.getByText("From arrivals.csv. 41 numbers read.")).toBeInTheDocument();
    await act(async () => void fireEvent.click(p.getByLabelText(w.eventTimes)));
    expect(p.getByText("From arrivals.csv. 41 event times give 40 gaps.")).toBeInTheDocument();
    await waitFor(() => expect(panelBody().querySelector("[data-fit-table]")).not.toBeNull(), WAIT);
    // Forty observations: no small-sample warning; a source's exponential fit is a Poisson process.
    expect(panelBody().querySelector("[data-fit-warning]")).toBeNull();
    const poisson = panelBody().querySelector<HTMLElement>('[data-fit-table] tr[data-family="poisson"]')!;
    expect(poisson.textContent).toContain("Poisson process (exponential gaps)");
    await act(async () => void fireEvent.click(within(poisson).getByRole("radio")));
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Use This Distribution" })));
    await waitFor(() => expect(nodeNamed(e, "Src1").distributionParameters).toMatch(/^lambda=0\.3422/), WAIT);
    expect(nodeNamed(e, "Src1").distribution).toBe("poisson");
  });

  it("says so when the preview cannot fit, and when a file cannot be read", async () => {
    show("2dtandem", "S1");
    const p = await openPanel();
    fireEvent.change(p.getByLabelText("Measured times"), { target: { value: "1 2 3 4 5 6 7 8 9 10 11 12" } });
    await waitFor(() => expect(p.getAllByText(/^The fit failed\. The browser preview fits only its two recorded samples/).length).toBeGreaterThan(0), WAIT);
    extendMock({
      "plugin:dialog|open": () => "/data/times.xlsx",
      fit_read_file: () => {
        throw { kind: "invalid", message: "“times.xlsx” is not a text file. Export the numbers as CSV or plain text first." };
      },
    });
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Choose File…" })));
    await waitFor(() => expect(p.getByText("Qnet couldn't read the file. “times.xlsx” is not a text file. Export the numbers as CSV or plain text first.")).toBeInTheDocument(), WAIT);
  });
});
