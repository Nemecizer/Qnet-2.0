// The Results workspace against the preview's replay of 0.90.34's own runs (src/dev/mock/runs.ts,
// golden/runs/): every record here is one 0.90.34 filed — completed, partial and failed — re-keyed
// to the test's tab. In 0.90.34's words (ledger §11.5, §11.6, §8.9, MENU-048, MENU-152, WS-016,
// WS-072).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { savedResultExports } from "../../dev/mock/results";
import { defaultHandlers } from "../../dev/mockBackend";
import { editorFor } from "../../editor";
import { displayFixed } from "../../editor/numbers";
import { getSetting, loadKv, setSettings } from "../../lib/kv";
import { extendMock, mockTauri } from "../../test/tauri";
import { mockRuns } from "../../dev/mock/runs";
import { onRunFinished, reloadResults, startRun } from "../../runs/state";
import { handlersFor } from "../../workspace/focus";
import { addTab, selectTab } from "../../workspace/store";
import { DETAIL_MIN, HISTORY_IDEAL, HISTORY_MIN, ResultsPane } from "./ResultsPane";
import { abbreviatedShort, failureGuidance } from "./model";
import { resultsWords as w } from "./words";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const records = import.meta.glob("../../../golden/runs/*/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden = (example: string, method: string): any => JSON.parse(records[`../../../golden/runs/${example}/${method}/record.json`]);

function openExample(stem: string): string {
  let id = "";
  act(() => {
    id = addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: { infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../../examples/${stem}.bnet`]) } });
  });
  return id;
}

/** Runs `method` on tab `id` (a replay of 0.90.34's run) and waits for its record to show. */
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

function Host() {
  return (
    <>
      <ResultsPane />
      <DialogHost />
    </>
  );
}

const runRows = () => [...document.querySelectorAll(".results-run")] as HTMLElement[];
const gridRows = () => [...document.querySelectorAll(".results-detail tbody tr")] as HTMLElement[];
const cells = (row: HTMLElement) => [...row.querySelectorAll("td")].map((c) => c.textContent);
const header = (name: string) => screen.getByRole("button", { name });

beforeEach(async () => {
  mockTauri(defaultHandlers());
  await loadKv();
});
afterEach(() => vi.restoreAllMocks());

describe("an empty tab", () => {
  it("says there are no results yet, with a 0 badge, and nothing to export or delete (RES-054, RES-059, RES-075)", async () => {
    openExample("2dtandem");
    render(<Host />);
    await act(async () => {});
    expect(screen.getByText("No Results Yet")).toBeInTheDocument();
    expect(screen.getByText("Run a method to create a reproducible record for this network.")).toBeInTheDocument();
    expect(screen.getByText("No Run Selected")).toBeInTheDocument();
    expect(screen.getByText("Select a run to inspect its measurements.")).toBeInTheDocument();
    const badge = document.querySelector(".pane-header .results-count")!;
    expect(badge.textContent).toBe("0");
    expect(badge).toHaveAttribute("title", "0 persisted run records for this tab");
    expect(screen.getByRole("button", { name: "Delete Result" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export results" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter results" })).toHaveAttribute("placeholder", "Filter methods, stations, metrics, or warnings");
    expect([...screen.getByRole("combobox", { name: "Model layer filter" }).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["All layers", "Queue", "Approximation", "SRBM", "Bound", "Mixed"]);
    expect([...screen.getByRole("combobox", { name: "Sort runs" }).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Newest", "Method", "Network"]);
  });

  it("has an inner split of history (min 224, ideal 320) and detail (min 496) (WS-072)", async () => {
    openExample("2dtandem");
    render(<Host />);
    const history = document.querySelector(".results-history") as HTMLElement;
    expect(history.style.flexBasis).toBe(`${HISTORY_IDEAL}px`);
    expect(history.style.minWidth).toBe(`${HISTORY_MIN}px`);
    expect((document.querySelector(".results-detail") as HTMLElement).style.minWidth).toBe(`${DETAIL_MIN}px`);
    const divider = screen.getByRole("separator", { name: "Resize the run history" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(history.style.flexBasis).toBe("300px");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(history.style.flexBasis).toBe(`${HISTORY_MIN}px`);
  });
});

describe("a completed Monte Carlo run of 2dtandem", () => {
  it("lists the run and shows its summary, evidence and measurements (RES-058, RES-061…063, RES-065, RES-067, RES-068)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    const g = golden("2dtandem", "sim");
    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Monte Carlo");
    expect(rows[0]).toHaveTextContent(`Queue · ${abbreviatedShort(g.startedAt)}`);
    expect(rows[0]).toHaveTextContent("8 measurements");
    expect(rows[0]).toHaveAttribute("title", "Monte Carlo · Queue simulation");
    expect(within(rows[0]).getByRole("img", { name: "Completed" })).toBeInTheDocument();
    expect(document.querySelector(".pane-header .results-count")!.textContent).toBe("1");
    expect(document.querySelector(".pane-header .results-count")).toHaveAttribute("title", "1 persisted run record for this tab");

    const detail = document.querySelector(".results-detail") as HTMLElement;
    expect(within(detail).getByRole("heading", { name: "Monte Carlo" })).toBeInTheDocument();
    expect(detail).toHaveTextContent("Queue simulation");
    expect(detail).toHaveTextContent("Completed");
    expect(detail).not.toHaveTextContent("Network changed");
    expect(detail).toHaveTextContent("Network2dtandem.bnet");
    expect(detail).toHaveTextContent("CapacityFinite capacity");
    expect(detail).toHaveTextContent(`Fingerprint${g.provenance.networkFingerprint.slice(0, 12)}`);
    expect(detail).toHaveTextContent("Elapsed0.344 s");
    const params = detail.querySelector(".results-params")!;
    expect(params.textContent).toBe("blocking=BAS+ext-loss  ·  fixed seed=true  ·  parallelism=2  ·  replications=8  ·  simulation time=200000  ·  warm-up=10000");
    expect(params).toHaveAttribute("title", "Complete parameters are retained in JSON exports");

    const evidence = screen.getByRole("region", { name: "Quality Evidence" });
    expect(evidence).toHaveTextContent("Statistical uncertainty");
    expect(evidence).toHaveTextContent("Reported for 8 of 8 measurements");
    expect(evidence).toHaveTextContent("Residuals and cross-run changes are numerical evidence, not statistical confidence intervals or queue-model error bounds.");

    expect([...detail.querySelectorAll("thead button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Sort by Station", "Sort by Class", "Sort by Metric", "Sort by Estimate", "Sort by Uncertainty / evidence", "Sort by Unit",
    ]);
    // Station ascending by default; output.decimals 6.
    const grid = gridRows();
    expect(grid).toHaveLength(8);
    expect(grid.map((r) => cells(r)[0])).toEqual(["S1", "S1", "S1", "S1", "S2", "S2", "S2", "S2"]);
    const util = grid.find((r) => cells(r)[2] === "Utilization" && cells(r)[0] === "S1")!;
    expect(cells(util)).toEqual(["S1", "All", "Utilization", "0.984000", "95% [0.983000, 0.985000]", "ratio"]);
    expect(util).toHaveAttribute("title", "95% confidence interval: [0.983000, 0.985000]");
  });

  it("shows estimates at Output decimals (RES-067)", async () => {
    const id = openExample("2dtandem");
    await setSettings({ "output.decimals": 3 });
    render(<Host />);
    await run(id, "sim");
    const util = gridRows().find((r) => cells(r)[2] === "Utilization" && cells(r)[0] === "S1")!;
    expect(cells(util)[3]).toBe("0.984");
    expect(cells(util)[4]).toBe("95% [0.983, 0.985]");
  });

  it("sorts by a column, ascending first and flipped by a second click (RES-066)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    fireEvent.click(header("Sort by Estimate"));
    const asc = gridRows().map((r) => Number(cells(r)[3]));
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(header("Sort by Estimate")).toHaveTextContent("Estimate ↑");
    fireEvent.click(header("Sort by Estimate"));
    const desc = gridRows().map((r) => Number(cells(r)[3]));
    expect(desc).toEqual([...asc].sort((a, b) => b - a));
    expect(header("Sort by Estimate")).toHaveTextContent("Estimate ↓");
    fireEvent.click(header("Sort by Uncertainty / evidence"));
    expect(header("Sort by Uncertainty / evidence")).toHaveTextContent("↑");
    // The narrowest interval first: S1 Utilization and S1/S2 Throughput (half-width 0.001).
    expect(cells(gridRows()[0])[4]).toMatch(/^95% \[0\.9/);
  });

  it("filters runs and measurements, and says when nothing matches (RES-055, RES-059)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    const filter = screen.getByRole("textbox", { name: "Filter results" });
    fireEvent.change(filter, { target: { value: "SOJOURN" } });
    expect(runRows()).toHaveLength(1);
    expect(gridRows().map((r) => cells(r)[2])).toEqual(["Mean sojourn time", "Mean sojourn time"]);
    fireEvent.change(filter, { target: { value: "no such thing" } });
    expect(runRows()).toHaveLength(0);
    expect(screen.getByText("No Matching Results")).toBeInTheDocument();
    expect(screen.getByText("Change the filter to show this tab's other runs.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Filter" }));
    expect(runRows()).toHaveLength(1);
    // The layer picker: a Queue run is not an SRBM run.
    fireEvent.change(screen.getByRole("combobox", { name: "Model layer filter" }), { target: { value: "srbm" } });
    expect(runRows()).toHaveLength(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Model layer filter" }), { target: { value: "queue" } });
    expect(runRows()).toHaveLength(1);
  });

  it("marks the run stale once the network changes, with 0.90.34's chip and tooltips (RES-050, RES-058, RES-061)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    await waitFor(() => expect(within(runRows()[0]).getByRole("img", { name: "Completed" })).toBeInTheDocument());
    const editor = editorFor(id);
    const node = editor.nodes[0];
    await act(async () => {
      editor.moveNode(node.id, { x: node.position[0] + 40, y: node.position[1] + 40 }, false);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByText("Network changed")).toBeInTheDocument());
    expect(screen.getByText("Network changed").closest(".results-chip")).toHaveAttribute("title", "This result remains valid for its saved network snapshot, but the current canvas no longer matches it.");
    expect(within(runRows()[0]).getByRole("img", { name: "Stale result" })).toBeInTheDocument();
    expect(runRows()[0]).toHaveAttribute("title", "Monte Carlo · Queue simulation · Network changed since this run");
  });

  it("selects a measurement's station on the canvas (RES-069)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    const g = golden("2dtandem", "sim");
    const s2 = gridRows().find((r) => cells(r)[0] === "S2")!;
    fireEvent.click(s2);
    expect(s2).toHaveAttribute("aria-selected", "true");
    const s2Id = g.measurements.find((m: { stationName: string }) => m.stationName === "S2").stationID;
    expect(String(editorFor(id).view.selectedNodeID).toUpperCase()).toBe(s2Id);
  });

  it("copies and saves its CSV and JSON through Rust's export, with 0.90.34's file names (RES-081, RES-082, RES-088, FILE-042, FILE-045)", async () => {
    const id = openExample("2dtandem");
    const clip: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void clip.push(t) } });
    const asked: { defaultPath?: string; filters?: { extensions: string[] }[] }[] = [];
    extendMock({ "plugin:dialog|save": ({ options }: { options: { defaultPath: string } }) => (asked.push(options), `/Users/preview/${options.defaultPath}`) });
    render(<Host />);
    await run(id, "sim");
    await run(id, "sm");
    const menu = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export results" }));
      return screen.findByRole("menu", { name: "Export results" });
    };
    let m = await menu();
    expect(within(m).getAllByRole("menuitem").map((x) => x.textContent)).toEqual([
      "Copy Selected Run as CSV", "Save Selected Run as CSV…", "Save Selected Run as JSON…", "Save Visible Runs as CSV…", "Save Visible Runs as JSON…",
    ]);
    await act(async () => fireEvent.click(within(m).getByRole("menuitem", { name: "Copy Selected Run as CSV" })));
    await waitFor(() => expect(clip).toHaveLength(1));
    const lines = clip[0].split("\n");
    expect(lines[0].split(",")).toHaveLength(31);
    expect(lines[0]).toBe("run_id,network,network_fingerprint,stale,status,method_id,method,model_layer,fidelity,started_at,completed_at,elapsed_seconds,station_id,station,class,metric,estimate,unit,standard_error,half_width,ci_lower,ci_upper,confidence_level,sample_size,residual,discretization,refinement_delta,note,seed,parameters,warnings");
    expect(clip[0].endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines[1]).toContain(",false,completed,");

    m = await menu();
    await act(async () => fireEvent.click(within(m).getByRole("menuitem", { name: "Save Selected Run as CSV…" })));
    await waitFor(() => expect(savedResultExports["/Users/preview/qnet-result.csv"]).toBeDefined());
    expect(asked.at(-1)!.defaultPath).toBe("qnet-result.csv");
    expect(asked.at(-1)!.filters![0].extensions).toEqual(["csv"]);

    m = await menu();
    await act(async () => fireEvent.click(within(m).getByRole("menuitem", { name: "Save Visible Runs as JSON…" })));
    await waitFor(() => expect(savedResultExports["/Users/preview/qnet-results.json"]).toBeDefined());
    const saved = JSON.parse(savedResultExports["/Users/preview/qnet-results.json"]);
    expect(Array.isArray(saved)).toBe(true);
    expect(saved).toHaveLength(2);
    expect(asked.at(-1)!.defaultPath).toBe("qnet-results.json");
  });

  it("shows a save failure as an alert (RES-082)", async () => {
    const id = openExample("2dtandem");
    extendMock({
      "plugin:dialog|save": () => "/readonly/qnet-result.csv",
      results_export_save: () => {
        throw { kind: "failed", message: "You don’t have permission to save the file “qnet-result.csv” in the folder “readonly”." };
      },
    });
    render(<Host />);
    await run(id, "sim");
    fireEvent.click(screen.getByRole("button", { name: "Export results" }));
    await act(async () => fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Save Selected Run as CSV…" })));
    const alert = await screen.findByRole("alertdialog");
    expect(alert).toHaveTextContent("You don’t have permission to save the file “qnet-result.csv” in the folder “readonly”.");
  });

  it("deletes the selected record after 0.90.34's question (RES-074)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    fireEvent.click(screen.getByRole("button", { name: "Delete Result" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this result?");
    expect(dialog).toHaveTextContent("The persisted run record and its measurements will be removed. The network is not changed.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(runRows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete Result" }));
    dialog = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete Result" })));
    await waitFor(() => expect(runRows()).toHaveLength(0));
    expect(screen.getByText("No Results Yet")).toBeInTheDocument();
  });

  it("shows the solver transcript behind a disclosure that copies it (RES-073)", async () => {
    const id = openExample("2dtandem");
    const clip: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void clip.push(t) } });
    render(<Host />);
    await run(id, "sim");
    const toggle = screen.getByRole("button", { name: "Solver Transcript" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("Verbatim standard output retained for audit and diagnostics.")).toBeInTheDocument();
    const g = golden("2dtandem", "sim");
    expect(document.querySelector(".results-transcript-text")!.textContent).toBe(g.rawOutput);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Transcript" })));
    expect(clip).toEqual([g.rawOutput]);
  });
});

describe("failed and partial runs", () => {
  it("shows a failed BAR Bounds run's failure card and no measurements (RES-070, RES-071)", async () => {
    const id = openExample("10stationtandem.inf");
    render(<Host />);
    await run(id, "bar_bounds");
    const g = golden("10stationtandem.inf", "bar_bounds");
    expect(within(runRows()[0]).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(runRows()[0]).toHaveTextContent("0 measurements");
    expect(screen.getByText("This run did not produce structured measurements.")).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Run Failed" });
    expect(card).toHaveTextContent(g.failureMessage);
    expect(card).toHaveTextContent("Next step: Open the Solver Transcript below, start with its last error line, and verify the active network's warnings and method assumptions before rerunning.");
    // Not a simulation, no evidence: no Quality Evidence panel.
    expect(screen.queryByRole("region", { name: "Quality Evidence" })).toBeNull();
  });

  it("shows a partial truncated-CTMC run's card, warnings and numerical evidence (RES-063, RES-071, RES-072)", async () => {
    const id = openExample("3dtandem.inf");
    render(<Host />);
    await run(id, "truncated_ctmc");
    const g = golden("3dtandem.inf", "truncated_ctmc");
    expect(within(runRows()[0]).getByRole("img", { name: "Partial" })).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Partial Result" });
    expect(card).toHaveTextContent(g.failureMessage);
    expect(card).toHaveTextContent(`Next step: ${w.guidance.partial[1]}`);
    const warnings = document.querySelector(".results-warnings")!;
    expect(warnings).toHaveTextContent("Warnings");
    expect(warnings).toHaveTextContent("The state-space cap was reached before the truncation checks passed.");
    const evidence = screen.getByRole("region", { name: "Quality Evidence" });
    expect(evidence).toHaveTextContent(`Numerical residual${displayFixed(g.runEvidence.residual, 6)}`);
    expect(evidence).toHaveTextContent(`Reported refinement Δ${displayFixed(g.runEvidence.refinementDelta, 6)}`);
  });

  it("picks the diagnosis by keywords in the message and transcript (RES-071)", () => {
    expect(failureGuidance("Spectral exited with status 1.", "error: No such file or directory", false).diagnosis).toBe("The selected solver executable could not be located.");
    expect(failureGuidance("x", "Permission denied", false).diagnosis).toBe("macOS refused to launch or read a required solver file.");
    expect(failureGuidance("network is unstable", "", false).diagnosis).toBe("The supplied network does not satisfy this method's steady-state stability condition.");
    expect(failureGuidance("x", "matrix is singular", false).diagnosis).toBe("The numerical system became singular or non-finite.");
    expect(failureGuidance("x", "LP infeasible", false).diagnosis).toBe("The optimization model did not yield a bounded feasible solution.");
    expect(failureGuidance("exited with status 137", "", false).diagnosis).toBe("The process was likely stopped because the selected resolution exceeded available resources.");
    expect(failureGuidance("x", "timed out", false).diagnosis).toBe("The solver did not finish within its allowed time.");
    expect(failureGuidance("not found", "", true)).toEqual({ diagnosis: "not found", action: w.guidance.partial[1] });
  });
});

describe("a run still in progress", () => {
  it("waits for its measurements with a spinner, and can't be chosen for a comparison (RES-070, RES-076)", async () => {
    const id = openExample("2dtandem");
    const g = golden("2dtandem", "sim");
    // As runs.rs files it at launch: running, no measurements yet.
    mockRuns.records.push({ ...g, id: "00000000-0000-4000-8000-000000000001", status: "running", measurements: [], completedAt: undefined, elapsedSeconds: undefined, rawOutput: undefined, provenance: { ...g.provenance, tabID: id.toUpperCase() } });
    render(<Host />);
    await act(async () => reloadResults(id));
    expect(within(runRows()[0]).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Waiting for structured measurements…" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for structured measurements…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare results" }));
    const m = await screen.findByRole("menu", { name: "Compare results" });
    expect(within(m).getByRole("menuitemcheckbox", { name: /^Monte Carlo · / })).toHaveAttribute("aria-disabled", "true");
  });

  it("lists \"No visible runs\" in Compare when the filter hides every run (RES-076)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter results" }), { target: { value: "zzz" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare results" }));
    const m = await screen.findByRole("menu", { name: "Compare results" });
    expect(m).toHaveTextContent("No visible runs");
  });
});

describe("comparing runs", () => {
  it("compares chosen runs oldest first, across layers, with a range column (RES-076…079)", async () => {
    const id = openExample("2dtandem");
    render(<Host />);
    await run(id, "sim");
    await run(id, "sm");
    const sim = golden("2dtandem", "sim");
    const sm = golden("2dtandem", "sm");
    const open = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Compare results" }));
      return screen.findByRole("menu", { name: "Compare results" });
    };
    let m = await open();
    expect(within(m).getByRole("menuitemcheckbox", { name: "Show Comparison" })).toHaveAttribute("aria-disabled", "true");
    expect(within(m).getByRole("menuitem", { name: "Clear Comparison" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(m).getByRole("menuitemcheckbox", { name: /^Monte Carlo · / }));
    m = await open();
    fireEvent.click(within(m).getByRole("menuitemcheckbox", { name: /^Spectral · / }));
    expect(screen.getByRole("button", { name: "Compare results" })).toHaveTextContent("2");
    m = await open();
    fireEvent.click(within(m).getByRole("menuitemcheckbox", { name: "Show Comparison" }));
    const detail = document.querySelector(".results-detail") as HTMLElement;
    expect(within(detail).getByRole("heading", { name: "Run Comparison" })).toBeInTheDocument();
    expect(detail).toHaveTextContent("2 runs");
    expect(detail).toHaveTextContent("These runs cross model layers. Agreement between SRBM methods checks SRBM numerics; it does not independently validate the queueing-process approximation.");
    expect(detail).not.toHaveTextContent("The selected runs used different network snapshots");
    const table = within(detail).getByRole("table", { name: "Comparison of 2 result runs" });
    expect([...table.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Station", "Class", "Metric", "Monte Carlo", "Spectral", "Range"]);
    const body = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(body).toHaveLength(8);
    // Sorted by "name|class|metric|unit".
    expect(body.map((r) => `${cells(r)[0]} ${cells(r)[2]}`).slice(0, 4)).toEqual(["S1 Mean reported occupancy", "S1 Mean sojourn time", "S1 Throughput", "S1 Utilization"]);
    const s1u = body.find((r) => cells(r)[0] === "S1" && cells(r)[2] === "Utilization")!;
    const est = (g: { measurements: { stationName: string; metric: string; estimate: number }[] }) => g.measurements.find((x) => x.stationName === "S1" && x.metric === "Utilization")!.estimate;
    expect(cells(s1u)).toEqual(["S1", "All", "Utilization", displayFixed(est(sim), 6), displayFixed(est(sm), 6), displayFixed(Math.abs(est(sm) - est(sim)), 6)]);
    // Clearing leaves the comparison.
    m = await open();
    fireEvent.click(within(m).getByRole("menuitem", { name: "Clear Comparison" }));
    expect(within(detail).queryByRole("heading", { name: "Run Comparison" })).toBeNull();
  });

  it("warns when the runs used different snapshots, and says when there is nothing to compare (RES-078, RES-080)", async () => {
    const id = openExample("10stationtandem.inf");
    render(<Host />);
    await run(id, "bar_bounds");
    await run(id, "bar_bounds");
    const [a] = mockRuns.records;
    a.provenance = { ...a.provenance, networkFingerprint: "0".repeat(64) };
    await act(async () => reloadResults(id));
    for (const i of [0, 1]) {
      fireEvent.click(screen.getByRole("button", { name: "Compare results" }));
      const m = await screen.findByRole("menu", { name: "Compare results" });
      fireEvent.click(within(m).getAllByRole("menuitemcheckbox")[i]);
    }
    fireEvent.click(screen.getByRole("button", { name: "Compare results" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Compare results" })).getByRole("menuitemcheckbox", { name: "Show Comparison" }));
    const detail = document.querySelector(".results-detail") as HTMLElement;
    expect(detail).toHaveTextContent("The selected runs used different network snapshots; differences may reflect changed inputs as well as methods.");
    expect(detail).not.toHaveTextContent("These runs cross model layers.");
    expect(detail).toHaveTextContent("No Comparable Measurements");
    expect(detail).toHaveTextContent("The selected runs have no structured measurements yet. Their solver transcripts remain available in each run.");
  });

  it("clears the selection and the comparison on a tab switch, keeping the filter (RES-060)", async () => {
    const a = openExample("2dtandem");
    render(<Host />);
    await run(a, "sim");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter results" }), { target: { value: "S1" } });
    const b = openExample("5stationtandem.inf");
    await act(async () => {});
    expect(screen.getByText("No Results Yet")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter results" })).toHaveValue("S1");
    act(() => selectTab(a));
    await waitFor(() => expect(runRows()).toHaveLength(1));
    expect(runRows()[0]).toHaveAttribute("aria-selected", "true");
    void b;
  });
});

describe("focus and find", () => {
  it("⌘F reads Filter Results… and, like Focus Results, puts the caret in the filter (MENU-048, MENU-152, RES-057)", async () => {
    openExample("2dtandem");
    render(<Host />);
    const h = handlersFor("results")!;
    expect(h.findTitle).toBe("Filter Results…");
    act(() => h.find!());
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter results" }));
    (document.activeElement as HTMLElement).blur();
    act(() => h.focus!());
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter results" }));
  });
});

describe("the first run's reveal (WS-016)", () => {
  it("shows Results once, when the Shell is hidden and nothing is maximized", async () => {
    render(<Host />);
    await setSettings({ "shell.paneVisible": false, "results.paneVisible": false, "results.autoShown": false });
    const id = openExample("2dtandem");
    await run(id, "sim");
    await waitFor(() => expect(getSetting("results.paneVisible", false)).toBe(true));
    expect(getSetting("results.autoShown", false)).toBe(true);
    // Never again.
    await setSettings({ "results.paneVisible": false });
    await run(id, "sm");
    expect(getSetting("results.paneVisible", true)).toBe(false);
  });

  it("does nothing while the Shell shows", async () => {
    render(<Host />);
    await setSettings({ "shell.paneVisible": true, "results.paneVisible": false, "results.autoShown": false });
    const id = openExample("2dtandem");
    await run(id, "sim");
    expect(getSetting("results.paneVisible", true)).toBe(false);
    expect(getSetting("results.autoShown", true)).toBe(false);
  });
});
