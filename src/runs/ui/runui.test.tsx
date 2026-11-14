// The Run and Test menus, the run panels, the status-bar run segment and the close guard
// (src/runs/ui), against the preview's replay of 0.90.34's own runs (src/dev/mock/runs.ts,
// src/dev/mock/testsets.ts, golden/runs/). Panels render into real (iframe) windows as AuxWindow
// opens them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockRuns } from "../../dev/mock/runs";
import { mockSweeps } from "../../dev/mock/testsets";
import { getCommand, registerCommands, runCommand, titleOf, unavailableReason } from "../../lib/commands";
import { getSetting, loadKv, resetKv, setSettings } from "../../lib/kv";
import { holdModal, MODAL_REASON, resetOverlays } from "../../lib/overlays";
import { isPanelOpen } from "../../lib/panel";
import { resolveMenu, type MenuNode } from "../../lib/menu";
import { channelSend, extendMock, mockTauri } from "../../test/tauri";
import { editorFeedback } from "../../editor/editor";
import { addTab, resetWorkspace, selectTab, tabById } from "../../workspace/store";
import { getRunState, onRunFinished, resetRuns, startRun, stopRun } from "../state";
import type { RunMessage, RunStartRequest } from "../../lib/types";
import { refreshMultiClassLookup, resetRunCommands, RUN_ITEMS, runCommands, runHelp } from "./commands";
import { refuseClosingRunOwner, runOwnsTab } from "./live";
import { RunPanelsHost } from "./RunPanels";
import { RunSegment } from "./RunSegment";
import { comparisonBlocking, finiteElement, initialForm, largestSpectralDegree, meshCap, spectralBytes, spectralInfinite, monteCarloInfinite, overridesFor, regenerative, REPLICATED_LEVELS, replicatedSimulation, sheetProblem, sheetValues } from "./specs";
import { getSweepState, resetSweeps } from "./sweeps";
import { rhoValues, spectralConvergenceDefaults, spectralConvergenceProblem, spectralConvergenceSummary, testSetDefaults, testSetProblem } from "./testsets";
import { clock, displayLabel } from "./words";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function openExample(stem: string): string {
  return addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: JSON.parse(examples[`../../../examples/${stem}.bnet`]) });
}

const frames: HTMLIFrameElement[] = [];
let opened: { name: string; win: Window }[] = [];
let unregister: () => void = () => {};
let beeps = 0;

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetRuns();
  resetSweeps();
  resetOverlays();
  resetRunCommands();
  mockRuns.replayMs = 60;
  mockSweeps.replayMs = 60;
  mockSweeps.mcSolver = true;
  beeps = 0;
  editorFeedback.beep = () => void beeps++;
  unregister = registerCommands(runCommands());
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
  // Nothing replays into the next test.
  if (getRunState().active) await act(async () => void (await stopRun()));
  mockSweeps.stop();
  await new Promise((r) => setTimeout(r, 0));
  unregister();
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

const panel = (id: string) => {
  const o = [...opened].reverse().find((x) => x.name === `qnet-panel-${id}`);
  if (!o) throw new Error(`no panel ${id}`);
  return within(o.win.document.body);
};

const when = (id: string) => unavailableReason(getCommand(id)!);
const lastStart = (): RunStartRequest => mockRuns.starts[mockRuns.starts.length - 1];
const finished = () =>
  new Promise<void>((resolve) => {
    const stop = onRunFinished(() => {
      stop();
      resolve();
    });
  });
/** Waits until no run is live: a started replay has finished, a refused one has been undone. */
const idle = () => waitFor(() => expect(getRunState().active).toBeNull(), { timeout: 4000 });
const logOf = (id: string) => tabById(id)!.log.map((l) => l.text);

/** Finds a native menu item by id. */
function menuItem(id: string): Extract<MenuNode, { type: "item" }> | undefined {
  const walk = (nodes: MenuNode[]): Extract<MenuNode, { type: "item" }> | undefined => {
    for (const n of nodes) {
      if (n.type === "item" && n.id === id) return n;
      if (n.type === "submenu") {
        const f = walk(n.items);
        if (f) return f;
      }
    }
    return undefined;
  };
  return walk(resolveMenu());
}

const INFINITE_ITEMS = RUN_ITEMS.filter((i) => i.mode === "infinite").map((i) => i.id);
const FINITE_ITEMS = RUN_ITEMS.filter((i) => i.mode === "finite").map((i) => i.id);

describe("the Run menu's enablement (MENU-111…113, METH-002, METH-003, MENU-198)", () => {
  it("needs a network, the item's buffer mode and no dialog up; a run in progress does not dim it", async () => {
    // The blank Untitled tab: every Run item dimmed, the tooltip saying why.
    for (const i of RUN_ITEMS) expect(when(i.id)).toBe("Open or draw a network first");
    expect(runHelp("run:qna")).toBe("Whitt's parametric decomposition (BNAqna · bna_qna) — propagates two-moment traffic variability station by station; instant, approximate (open or draw a network first)");

    openExample("2dtandem");
    for (const id of FINITE_ITEMS) expect(when(id)).toBeNull();
    for (const id of INFINITE_ITEMS) expect(when(id)).toBe("This network has finite buffers");
    expect(when("run:comparison")).toBeNull();
    expect(runHelp("run:sbd")).toMatch(/spectrally \(this network has finite buffers\)$/);
    expect(runHelp("run:comparison")).toBe("Run every method for the current buffer mode and tabulate the results side by side — ⌥⌘ + letter runs one method; Help ▸ Keyboard Shortcuts lists them");

    const inf = openExample("5stationtandem.inf");
    for (const id of INFINITE_ITEMS) expect(when(id)).toBeNull();
    for (const id of FINITE_ITEMS) expect(when(id)).toBe("This network has infinite buffers");
    expect(runHelp("run:finite-element")).toMatch(/\(this network has infinite buffers\)$/);

    const release = holdModal();
    for (const i of RUN_ITEMS) expect(when(i.id)).toBe(MODAL_REASON);
    release();

    // A run of another tab doesn't dim anything: the launch refuses instead.
    mockRuns.replayMs = 5000;
    await startRun(inf, "qna");
    expect(when("run:sbd")).toBeNull();
    await act(async () => void (await runCommand("run:sbd")));
    expect(logOf(inf).at(-1)).toBe("SBD was not started because QNA is already running for “5stationtandem.inf.bnet”. Stop or wait for that run first.");
  });

  it("gives the shared key to whichever of a buffer-mode pair is enabled (MENU-114, METH-004)", () => {
    openExample("2dtandem");
    expect(menuItem("run:monte-carlo-infinite")?.accel).toBeUndefined();
    expect(menuItem("run:monte-carlo-finite")?.accel).toBe("CmdOrCtrl+Alt+M");
    expect(menuItem("run:finite-lp")?.accel).toBe("CmdOrCtrl+Alt+L");
    expect(menuItem("run:finite-element")?.accel).toBe("CmdOrCtrl+Alt+F");
    openExample("5stationtandem.inf");
    expect(menuItem("run:monte-carlo-infinite")?.accel).toBe("CmdOrCtrl+Alt+M");
    expect(menuItem("run:spectral-finite")?.accel).toBeUndefined();
    expect(menuItem("run:qna")?.accel).toBe("CmdOrCtrl+Alt+Q");
  });

  it("names Multi-Class SRBM by whether mc_solver resolves (MENU-135, METH-006)", async () => {
    openExample("5stationtandem.inf");
    await refreshMultiClassLookup();
    expect(titleOf(getCommand("run:multiclass")!)).toBe("Run Multi-Class SRBM…");
    expect(when("run:multiclass")).toBeNull();
    mockSweeps.mcSolver = false;
    await refreshMultiClassLookup();
    expect(titleOf(getCommand("run:multiclass")!)).toBe("Multi-Class SRBM — Unavailable");
    expect(when("run:multiclass")).toMatch(/^mc_solver was not found/);
    expect(runHelp("run:multiclass")).toMatch(/^mc_solver was not found/);
  });
});

describe("what each item runs (MENU-115…134, METH-005)", () => {
  it("starts 0.90.34's run label straight away for the items without a sheet", async () => {
    const direct: [string, string, string][] = [
      ["5stationtandem.inf", "run:product-form", "product_form"],
      ["5stationtandem.inf", "run:qbd", "qbd"],
      ["5stationtandem.inf", "run:truncated-ctmc", "truncated_ctmc"],
      ["5stationtandem.inf", "run:qna", "qna"],
      ["5stationtandem.inf", "run:rqna", "rqna"],
      ["5stationtandem.inf", "run:sbd", "sbd"],
      ["5stationtandem.inf", "run:mlmc", "mlmc"],
      ["5stationtandem.inf", "run:lp", "lp"],
      ["5stationtandem.inf", "run:low-rank-bar", "adaptive_bar"],
      ["5stationtandem.inf", "run:bar-bounds", "bar_bounds"],
      ["5stationtandem.inf", "run:comparison", "inf_cmp"],
      ["2dtandem", "run:generic-ctmc", "generic_ctmc"],
      ["2dtandem", "run:decomposition", "fb_decomp"],
      ["2dtandem", "run:finite-lp", "flp"],
    ];
    for (const [ex, id, label] of direct) {
      openExample(ex);
      const done = mockRuns.starts.length;
      await act(async () => void (await runCommand(id)));
      expect(mockRuns.starts.length, id).toBe(done + 1);
      expect(lastStart().method, id).toBe(label);
      expect(lastStart().overrides, id).toEqual({});
      await idle();
      expect(isPanelOpen("run-parameters")).toBe(false);
    }
  }, 20_000);

  it("asks first for the items with a sheet, then runs their label", async () => {
    render(<RunPanelsHost />);
    const sheeted: [string, string, string, string][] = [
      ["5stationtandem.inf", "run:monte-carlo-infinite", "inf_sim", "Run Monte Carlo"],
      ["5stationtandem.inf", "run:regenerative-infinite", "regenerative_mc", "Run Regenerative Monte Carlo"],
      ["5stationtandem.inf", "run:spectral-infinite", "inf_sm", "Run Spectral Method"],
      ["5stationtandem.inf", "run:multiclass", "mc", "Run Multi-Class SRBM"],
      ["2dtandem", "run:monte-carlo-finite", "sim", "Run Monte Carlo"],
      ["2dtandem", "run:regenerative-finite", "regenerative_mc", "Run Regenerative Monte Carlo"],
      ["2dtandem", "run:spectral-finite", "sm", "Run Spectral Method"],
      ["2dtandem", "run:finite-element", "fm", "Run Finite Element"],
      ["2dtandem", "run:comparison", "cmp", "Run Comparison"],
    ];
    for (const [ex, id, label, title] of sheeted) {
      openExample(ex);
      const done = mockRuns.starts.length;
      await act(async () => void (await runCommand(id)));
      expect(mockRuns.starts.length, id).toBe(done);
      await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
      const o = opened.at(-1)!;
      expect(o.win.document.title, id).toBe(title);
      await act(async () => fireEvent.click(panel("run-parameters").getByRole("button", { name: "Run" })));
      await waitFor(() => expect(mockRuns.starts.length, id).toBe(done + 1));
      expect(lastStart().method, id).toBe(label);
      expect(lastStart().overrides, `${id} confirmed unchanged`).toEqual({});
      await idle();
    }
  }, 20_000);

  it("asks before the infinite LP only when Settings ▸ Linear Program says so (METH-005, METH-080)", async () => {
    render(<RunPanelsHost />);
    openExample("5stationtandem.inf");
    await setSettings({ "lp.askBeforeRun": true });
    await act(async () => void (await runCommand("run:lp")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    const p = panel("run-parameters");
    expect(p.getByText("LP relaxation of the SRBM stationary distribution (BNAlp, Saure–Glynn–Zeevi 2008) for d = 5.")).toBeInTheDocument();
    expect((p.getByRole("textbox", { name: "Grid size n" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(p.getByRole("combobox", { name: "LP backend" }), { target: { value: "3" } });
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Run" })));
    await waitFor(() => expect(lastStart()?.method).toBe("lp"));
    expect(lastStart().overrides).toEqual({ "lp.solver": 3 });
  });
});

describe("the run-parameter sheets (METH-009…014, §7.3, §7.4, §7.5)", () => {
  it("open from the settings, clamp a committed value, name the first problem, and Cancel with the method's line", async () => {
    render(<RunPanelsHost />);
    const id = openExample("5stationtandem.inf");
    await setSettings({ "sim.replications": 12 });
    await act(async () => void (await runCommand("run:monte-carlo-infinite")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    const p = panel("run-parameters");
    const reps = p.getByRole("textbox", { name: "Replications" }) as HTMLInputElement;
    expect(reps.value).toBe("12");
    expect((p.getByRole("textbox", { name: "Warm-up period" }) as HTMLInputElement).value).toBe("1000000");
    expect(p.getByText("Discrete-event simulation of the infinite-buffer network (jackson_sim). No blocking regime applies — buffers are unbounded.")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Set as default" })).toBeEnabled();

    // Mid-edit, out of range: the footer names it and Run waits.
    fireEvent.change(reps, { target: { value: "200000" } });
    expect(p.getByRole("status", { name: "Cannot continue: Replications must be between 1 and 100000." })).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(p.getByRole("button", { name: "Run" })).toHaveAttribute("title", "Fix the highlighted values to run");
    // Committed: clamped, and said so.
    fireEvent.blur(reps);
    expect(reps.value).toBe("100000");
    expect(p.getByText("Clamped to 100000")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Run" })).toBeEnabled();

    const before = mockRuns.starts.length;
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Cancel" })));
    expect(isPanelOpen("run-parameters")).toBe(false);
    expect(mockRuns.starts.length).toBe(before);
    expect(tabById(id)!.log.at(-1)).toMatchObject({ text: "Simulation (infinite) cancelled.", severity: "warning" });
  });

  it("passes only what changed, by the runner's setting keys, and Set as Default writes 0.90.34's keys", async () => {
    render(<RunPanelsHost />);
    openExample("2dtandem");
    await act(async () => void (await runCommand("run:monte-carlo-finite")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    const p = panel("run-parameters");
    fireEvent.change(p.getByRole("combobox", { name: "Blocking" }), { target: { value: "0" } });
    fireEvent.change(p.getByRole("textbox", { name: "Replications" }), { target: { value: "8" } });
    fireEvent.click(p.getByRole("switch", { name: "Use fixed seed" }));
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Set as default" })));
    await waitFor(() => expect(p.getByRole("button", { name: "Set as default" })).toHaveTextContent("Saved as Default"));
    expect(getSetting("sim.blocking", -1)).toBe(0);
    expect(getSetting("sim.replications", -1)).toBe(8);
    expect(getSetting("sim.seedFixed", false)).toBe(true);
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Run" })));
    await waitFor(() => expect(lastStart()?.method).toBe("sim"));
    expect(lastStart().overrides).toEqual({ "sim.blocking": 0, "sim.replications": 8, "sim.seedFixed": true });
    // The replayed run is 0.90.34's own.
    await idle();
    expect(getRunState().last?.summary).toBe("Monte Carlo finished in 0.3 s");
  });

  it("confirmed unchanged, a sheet gives exactly the settings the run has without it", () => {
    for (const spec of [monteCarloInfinite(), comparisonBlocking(), finiteElement(4), finiteElement(2)]) {
      const form = initialForm(spec);
      expect(sheetProblem(spec, form)).toBeNull();
      expect(overridesFor(spec, sheetValues(spec, form)), spec.title).toEqual({});
    }
    // Answers the runner has no setting for travel under keys of their own (asked of the lead).
    const regen = regenerative(true);
    expect(overridesFor(regen, { ...regen.values, confidence: 0.9, seed: 7 })).toEqual({ "regenerative.confidence": 0.9, "sim.seed": 7 });
    expect(regen.defaults).toBeUndefined();
    // Replicated Simulation (new in 2.1, SIM-109): opens on the estimator's defaults (core/src/simstat.rs
    // `Options::default`, runner `siminproc::options`), unchanged it overrides nothing, and each
    // answer travels under the `siminproc.*` key the runner reads.
    const replicated = replicatedSimulation(true);
    expect(replicated.values).toMatchObject({ replications: 20, completions: 200_000, warmup: 0, warmupFraction: 0.1, confidence: 1, precision: 0, maximumReplications: 1000, maximumWallSeconds: 60 });
    expect(sheetProblem(replicated, initialForm(replicated))).toBeNull();
    expect(overridesFor(replicated, sheetValues(replicated, initialForm(replicated)))).toEqual({});
    expect(overridesFor(replicated, { ...replicated.values, replications: 40, completions: 50_000, warmup: 1, warmupFraction: 0.2, confidence: 2, precision: 0.02, seedFixed: true, seed: 7 })).toEqual({
      "siminproc.replications": 40, "siminproc.completions": 50_000, "siminproc.warmup": 1, "siminproc.warmupFraction": 0.2, "siminproc.confidence": 2, "siminproc.precision": 0.02, "sim.seedFixed": true, "sim.seed": 7,
    });
    expect(replicated.sections.map((s) => s.title)).toEqual(["Run Length", "Warm-up", "Precision", "Reproducibility"]);
    expect([replicated.helpTopic, replicated.defaults, replicatedSimulation(false).subtitle]).toEqual(["replicatedSimulation", undefined, "Steady-state simulation of the infinite-buffer network inside Qnet, with a confidence interval on every estimate."]);
    expect(REPLICATED_LEVELS).toEqual(["90 %", "95 %", "99 %"]);
    // The finite-element sheet opens at min(fem.meshSize, cap): 8 for d = 4, the setting below 4.
    expect([0, 3, 4, 5, 6, 9].map(meshCap)).toEqual([20, 20, 8, 6, 4, 4]);
    // The infinite spectral sheet opens on the largest degree the 2 GB guard allows, and says so.
    expect(spectralInfinite(5).values.degree).toBe(8);
    expect(spectralInfinite(5).sections[0].notice).toBeUndefined();
    expect(spectralBytes(20, 8)).toBeCloseTo(3108105 ** 2 * 8, -6);
    expect(largestSpectralDegree(20, 8)).toBe(4);
    expect(spectralInfinite(20).values.degree).toBe(4);
    expect(spectralInfinite(20).sections[0].notice).toBe("Degree changed from 8 to 4: with 20 stations, 4 is the largest degree whose matrix fits the 2 GB memory limit.");
    // Not even degree 2 fits: the sheet is left alone and the run refuses in 0.90.34's words.
    expect(largestSpectralDegree(400, 8)).toBeNull();
    expect(spectralInfinite(400).values.degree).toBe(8);
    expect(spectralInfinite(400).sections[0].notice).toBeUndefined();
    expect(finiteElement(4).values.mesh).toBe(8);
    expect(finiteElement(4).sections[0].footer).toBe("The mesh is capped at 8 for d = 4: the finite-element cost grows as n^2d, so larger meshes run much longer.");
    expect(finiteElement(2).values.mesh).toBe(10);
    expect(finiteElement(2).sections[0].footer).toBe("Cost grows as n^2d in the mesh size n and the number of stations d.");
  });

  it("asks for the finite comparison's regime unless remembered, and remembers only when told (METH-117, METH-118)", async () => {
    render(<RunPanelsHost />);
    const id = openExample("2dtandem");
    await act(async () => void (await runCommand("run:comparison")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    let p = panel("run-parameters");
    expect(p.getByRole("button", { name: "Run" })).toHaveAttribute("title", "Run every method and tabulate the results (Return)");
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Cancel" })));
    expect(logOf(id).at(-1)).toBe("Comparison cancelled.");

    await act(async () => void (await runCommand("run:comparison")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    p = panel("run-parameters");
    fireEvent.change(p.getByRole("combobox", { name: "Blocking regime" }), { target: { value: "1" } });
    fireEvent.click(p.getByRole("switch", { name: "Skip this dialog from now on" }));
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Run" })));
    await waitFor(() => expect(lastStart()?.method).toBe("cmp"));
    expect(getSetting("runCompare.remember", false)).toBe(true);
    expect(getSetting("sim.blocking", -1)).toBe(1);
    await idle();

    // Remembered: no sheet; the stored regime is used.
    const n = mockRuns.starts.length;
    await act(async () => void (await runCommand("run:comparison")));
    expect(isPanelOpen("run-parameters")).toBe(false);
    expect(mockRuns.starts.length).toBe(n + 1);
    expect(lastStart().settings["sim.blocking"]).toBe(1);
  });

  it("is refused while another run owns the Shell, and while a dialog is up (METH-014)", async () => {
    render(<RunPanelsHost />);
    const a = openExample("5stationtandem.inf");
    mockRuns.replayMs = 5000;
    await startRun(a, "qna");
    const b = openExample("3dtandem.inf");
    await act(async () => void (await runCommand("run:spectral-infinite")));
    expect(isPanelOpen("run-parameters")).toBe(false);
    expect(beeps).toBe(1);
    expect(tabById(b)!.log.at(-1)).toMatchObject({ text: "Run Spectral Method cannot open while QNA is running for “5stationtandem.inf.bnet”. Stop or wait for that run first.", severity: "warning" });
  });

  it("closing the panel by its window is Cancel; Run can't be followed by the cancel line (METH-013)", async () => {
    render(<RunPanelsHost />);
    const id = openExample("2dtandem");
    await act(async () => void (await runCommand("run:spectral-finite")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    const o = opened.at(-1)!;
    await act(async () => fireEvent.keyDown(o.win.document.body, { key: "Escape" }));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(false));
    expect(logOf(id).at(-1)).toBe("Spectral method run cancelled.");

    await act(async () => void (await runCommand("run:spectral-finite")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    // Return in a field runs.
    await act(async () => fireEvent.keyDown(panel("run-parameters").getByRole("textbox", { name: "Polynomial degree" }), { key: "Enter" }));
    await waitFor(() => expect(lastStart()?.method).toBe("sm"));
    await idle();
    expect(logOf(id).filter((t) => t === "Spectral method run cancelled.")).toHaveLength(1);
  });
});

describe("before the run (RUN-017)", () => {
  it("opens a hidden Status pane for a refusal, but not for the single-flight sentence", async () => {
    const id = openExample("2dtandem");
    await setSettings({ "status.paneVisible": false });
    await act(async () => void (await runCommand("run:generic-ctmc")));
    expect(logOf(id).at(-1)).toBe("Exact sparse CTMC not started: S1, Class 1 uses Deterministic service. This method requires exponential service times.");
    await waitFor(() => expect(getSetting("status.paneVisible", false)).toBe(true));

    mockRuns.replayMs = 5000;
    const inf = openExample("5stationtandem.inf");
    await startRun(inf, "qna");
    await setSettings({ "status.paneVisible": false });
    selectTab(id);
    await act(async () => void (await runCommand("run:decomposition")));
    expect(logOf(id).at(-1)).toMatch(/was not started because QNA is already running/);
    await new Promise((r) => setTimeout(r, 30));
    expect(getSetting("status.paneVisible", true)).toBe(false);
  });
});

describe("Run ▸ Stop and the status bar's run segment (RUN-046, RUN-051, CAN-163, MENU-136)", () => {
  it("reads Idle, then the live run with Stop, then the last outcome", async () => {
    render(<RunSegment />);
    expect(screen.getByText("Idle").parentElement).toHaveAttribute("title", "No solver run yet — use the Run menu");
    expect(titleOf(getCommand("run:stop")!)).toBe("Stop Run");
    expect(when("run:stop")).toBe("Nothing is running");

    const id = openExample("5stationtandem.inf");
    const done = finished();
    await act(async () => void (await runCommand("run:qna")));
    expect(screen.getByText("Running QNA for 5stationtandem.inf.bnet… 0:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Run" })).toHaveAttribute("title", "Stop QNA (Run ▸ Stop QNA, ⌘.) — sends the same interrupt ⌃C would in the Shell");
    expect(titleOf(getCommand("run:stop")!)).toBe("Stop QNA");
    expect(when("run:stop")).toBeNull();
    await act(() => done);
    expect(screen.getByText("QNA finished in 0.3 s · 5stationtandem.inf.bnet")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Last run: QNA finished in 0.3 s" })).toHaveAttribute("data-state", "success");

    // Stop, live from the click: the tab is told "<run> cancelled." and the segment turns to warning.
    mockRuns.replayMs = 5000;
    const stopped = finished();
    await act(async () => void (await runCommand("run:sbd")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop Run" })));
    await act(() => stopped);
    expect(logOf(id).at(-1)).toBe("SBD cancelled.");
    expect(screen.getByText("SBD cancelled after 0.1 s · 5stationtandem.inf.bnet")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Last run/ })).toHaveAttribute("data-state", "warning");
  });

  it("shows a determinate bar with \"47% · m:ss\" when the solver reports progress", async () => {
    const id = openExample("5stationtandem.inf");
    let channel: unknown = null;
    extendMock({
      run_start: ({ channel: c }: { channel: unknown }) => {
        channel = c;
        return { started: true };
      },
    });
    render(<RunSegment />);
    await act(async () => void (await startRun(id, "inf_sim")));
    await act(async () => channelSend(channel, { kind: "progress", fraction: 0.47, elapsedSeconds: 1, text: "47% · 0:01" } satisfies RunMessage));
    expect(screen.getByText(/^47% · 0:0\d$/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("value", "0.47");
    expect(screen.getByRole("group", { name: /^Running Monte Carlo for 5stationtandem\.inf\.bnet, 47 percent/ })).toBeInTheDocument();
    await act(async () => channelSend(channel, { kind: "finished", summary: "Monte Carlo failed (exit 1) after 0.1 s", statusBar: "Monte Carlo failed (exit 1) after 0.1 s", exitCode: 1, userStopped: false, succeeded: false, recordId: null, filed: null, filedReason: null } satisfies RunMessage));
    expect(screen.getByRole("group", { name: /^Last run/ })).toHaveAttribute("data-state", "failure");
  });

  it("formats the clock as 0.90.34 did and names runs by their display label", () => {
    expect([0, 0.4, 59.6, 61, 3600].map(clock)).toEqual(["0:00", "0:00", "1:00", "1:01", "60:00"]);
    expect(["inf_cmp", "sm", "regenerative_mc", "adaptive_bar", "testset"].map(displayLabel)).toEqual(["Run Comparison", "Spectral", "Regenerative Mc", "Adaptive Bar", "Test Set"]);
  });
});

describe("a tab with a run can't be closed (WS-043)", () => {
  it("refuses with a beep and the sentence in the owning tab", async () => {
    mockRuns.replayMs = 5000;
    const a = openExample("5stationtandem.inf");
    const b = openExample("2dtandem");
    expect(runOwnsTab(a)).toBe(false);
    expect(refuseClosingRunOwner([a])).toBe(false);
    await startRun(a, "qna");
    expect(runOwnsTab(a)).toBe(true);
    expect(runOwnsTab(b)).toBe(false);
    expect(refuseClosingRunOwner([b])).toBe(false);
    expect(refuseClosingRunOwner([b, a])).toBe(true);
    expect(beeps).toBe(1);
    expect(tabById(a)!.log.at(-1)).toMatchObject({ text: "“5stationtandem.inf.bnet” cannot be closed while QNA is running. Stop or wait for the run first.", severity: "warning" });
  });
});

describe("the Test menu (§1.8, §7.6, §14.9)", () => {
  it("needs no network, waits under a dialog, and opens each panel from Settings ▸ Test Sets (MENU-137…139, TEST-001, TEST-002)", async () => {
    render(<RunPanelsHost />);
    for (const id of ["test:infinite", "test:finite", "test:spectral-convergence"]) expect(when(id)).toBeNull();
    const release = holdModal();
    expect(when("test:infinite")).toBe(MODAL_REASON);
    release();
    await setSettings({ "testset.inf.stationsHi": 9, "testset.inf.topology": 2 });
    await act(async () => void (await runCommand("test:infinite")));
    await waitFor(() => expect(isPanelOpen("test-set")).toBe(true));
    expect(opened.at(-1)!.win.document.title).toBe("Run Infinite Test Set");
    const p = panel("test-set");
    expect(p.getByText("Generates random infinite-buffer networks, runs every infinite-regime method on each and reports the per-method accuracy averaged over the sweep.")).toBeInTheDocument();
    expect((p.getByRole("textbox", { name: "Maximum stations" }) as HTMLInputElement).value).toBe("9");
    expect((p.getByRole("combobox", { name: "Topology" }) as HTMLSelectElement).value).toBe("2");
    expect((p.getByRole("textbox", { name: "Minimum target utilisation" }) as HTMLInputElement).value).toBe("0.50");
    expect(p.getByText("20 random infinite-buffer networks, each solved by every infinite-buffer method and scored against the simulator.")).toBeInTheDocument();
    // The seed opens off; switching it on shows the Seed field at 12345.
    expect(p.queryByRole("textbox", { name: "Test-set seed" })).toBeNull();
    fireEvent.click(p.getByRole("switch", { name: "Fixed random seed" }));
    expect((p.getByRole("textbox", { name: "Test-set seed" }) as HTMLInputElement).value).toBe("12345");
    fireEvent.change(p.getByRole("textbox", { name: "Minimum stations" }), { target: { value: "12" } });
    expect(p.getByRole("status", { name: "Cannot continue: Minimum stations must not exceed the maximum." })).toBeInTheDocument();
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Cancel" })));
    expect(isPanelOpen("test-set")).toBe(false);
    // Values changed in the sheet are not written back.
    expect(getSetting("testset.inf.stationsLo", 0)).toBe(3);
  });

  it("validates in row order with 0.90.34's sentences (METH-133…137, TEST-006, METH-146, METH-147, TEST-023)", () => {
    const f = testSetDefaults(false);
    expect(f).toMatchObject({ stationsLower: "2", stationsUpper: "4", classesLower: "1", classesUpper: "2", numCases: "10", fixedSeed: false, seed: "12345" });
    expect(testSetProblem(f)).toBeNull();
    expect(testSetProblem({ ...f, stationsUpper: "33" })).toBe("Stations must be between 1 and 32.");
    expect(testSetProblem({ ...f, classesUpper: "17" })).toBe("Customer classes must be between 1 and 16.");
    expect(testSetProblem({ ...f, classesLower: "3" })).toBe("Minimum classes must not exceed the maximum.");
    expect(testSetProblem({ ...f, rhoUpper: "1" })).toBe("ρ must lie strictly between 0 and 1.");
    expect(testSetProblem({ ...f, rhoLower: "0.9" })).toBe("Minimum ρ must not exceed the maximum.");
    expect(testSetProblem({ ...f, numCases: "1001" })).toBe("Test cases must be between 1 and 1000.");
    const s = spectralConvergenceDefaults();
    expect(s).toMatchObject({ stationsLower: "3", stationsUpper: "6", rhoStart: "0.50", rhoEnd: "0.95", rhoStep: "0.05", numCases: "10" });
    expect(spectralConvergenceSummary(s)).toBe("10 cases × 10 ρ values = 100 spectral solves, each checked against simulation (QNA is the flat-line baseline).");
    expect(spectralConvergenceProblem({ ...s, rhoStep: "0.6" })).toBe("ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.");
    expect(spectralConvergenceSummary({ ...s, rhoStep: "0" })).toBe("Choose a valid ρ sweep to see the number of solves.");
    expect(spectralConvergenceProblem({ ...s, numCases: "201" })).toBe("Test cases must be between 1 and 200.");
    expect(spectralConvergenceSummary({ ...s, numCases: "1", rhoStart: "0.50", rhoEnd: "0.70", rhoStep: "0.20" })).toBe("1 case × 2 ρ values = 2 spectral solves, each checked against simulation (QNA is the flat-line baseline).");
    expect(rhoValues(0.5, 0.7, 0.1).map((v) => v.toFixed(3))).toEqual(["0.500", "0.600", "0.700"]);
    expect(rhoValues(0.5, 0.95, 0)).toEqual([0.5]);
  });

  it("runs a sweep for the active tab and keeps the Test menu dimmed until it has finished (TEST-020, Changed)", async () => {
    render(<RunPanelsHost />);
    render(<RunSegment />);
    const id = openExample("2dtandem");
    mockSweeps.replayMs = 200;
    await act(async () => void (await runCommand("test:finite")));
    await waitFor(() => expect(isPanelOpen("test-set")).toBe(true));
    const p = panel("test-set");
    fireEvent.click(p.getByRole("switch", { name: "Fixed random seed" }));
    fireEvent.change(p.getByRole("textbox", { name: "Test-set seed" }), { target: { value: "20261111" } });
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Run" })));
    expect(isPanelOpen("test-set")).toBe(false);
    await waitFor(() => expect(mockSweeps.starts).toHaveLength(1));
    expect(mockSweeps.starts[0]).toMatchObject({ tabId: id, kind: "finite", params: { stationsLower: 2, stationsUpper: 4, classesLower: 1, classesUpper: 2, rhoLower: 0.5, rhoUpper: 0.85, numTestCases: 10, topology: 0, seed: 20261111 } });
    await waitFor(() => expect(when("test:infinite")).toBe("A test set is running"));
    expect(when("test:spectral-convergence")).toBe("A test set is running");
    expect(screen.getByText(/^Running Test Set for 2dtandem\.bnet… 0:0\d$/)).toBeInTheDocument();
    // The replay is 200 ms of timers; on a busy Mac the full suite has taken over a second here.
    await waitFor(() => expect(getSweepState().active ?? getRunState().active).toBeNull(), { timeout: 8000 });
    expect(when("test:infinite")).toBeNull();
    expect(screen.getByText("Test Set finished in 1.4 s · 2dtandem.bnet")).toBeInTheDocument();
    expect(mockSweeps.records[0].provenance.tabID).toBe(id.toUpperCase());
  });

  it("runs the spectral convergence sweep with its ρ grid", async () => {
    render(<RunPanelsHost />);
    openExample("5stationtandem.inf");
    await act(async () => void (await runCommand("test:spectral-convergence")));
    await waitFor(() => expect(isPanelOpen("spectral-convergence")).toBe(true));
    expect(opened.at(-1)!.win.document.title).toBe("Run Infinite Spectral Convergence");
    const p = panel("spectral-convergence");
    fireEvent.change(p.getByRole("textbox", { name: "Sweep step" }), { target: { value: "0.6" } });
    expect(p.getByText("Step must be positive and at most end − start")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Run" })).toBeDisabled();
    fireEvent.change(p.getByRole("textbox", { name: "Sweep step" }), { target: { value: "0.15" } });
    expect(p.getByText("10 cases × 4 ρ values = 40 spectral solves, each checked against simulation (QNA is the flat-line baseline).")).toBeInTheDocument();
    await act(async () => fireEvent.click(p.getByRole("button", { name: "Run" })));
    await waitFor(() => expect(mockSweeps.starts).toHaveLength(1));
    expect(mockSweeps.starts[0]).toMatchObject({ kind: "spc", params: { rhoStart: 0.5, rhoEnd: 0.95, rhoStep: 0.15, numTestCases: 10, seed: null } });
    await waitFor(() => expect(getSweepState().active ?? getRunState().active).toBeNull());
  });
});

describe("the spectral sheet on a network too large for the stored degree (owner's request, 2026-11-12)", () => {
  it("opens on the largest degree that fits, says “Degree changed” in red, and runs at that degree", async () => {
    render(<RunPanelsHost />);
    openExample("20stationtandem.inf");
    await act(async () => void (await runCommand("run:spectral-infinite")));
    await waitFor(() => expect(isPanelOpen("run-parameters")).toBe(true));
    const notice = await panel("run-parameters").findByRole("alert");
    expect(notice).toHaveTextContent("Degree changed from 8 to 4: with 20 stations, 4 is the largest degree whose matrix fits the 2 GB memory limit.");
    expect(notice).toHaveClass("qn-sheet-section-notice");
    const done = mockRuns.starts.length;
    await act(async () => fireEvent.click(panel("run-parameters").getByRole("button", { name: "Run" })));
    await waitFor(() => expect(mockRuns.starts.length).toBe(done + 1));
    expect(lastStart().method).toBe("inf_sm");
    expect(lastStart().overrides).toEqual({ "sm.degree": 4 });
    // The stored default is untouched unless the user chooses Set as Default.
    expect(getSetting("sm.degree", 8)).toBe(8);
  });
});
