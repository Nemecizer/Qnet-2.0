// Network ▸ Analyze Network, Show Network Primitives and the Primitives report after every open,
// against the preview's replay of 0.90.34's own reports (src/dev/mock/analysis.ts, golden/<example>/
// analysis.txt and primitives.txt). Ledger ANA-028, ANA-138…143, ANA-170…175, MENU-086…088,
// MENU-162, WS-111, RUN-045.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { defaultHandlers } from "../dev/mockBackend";
import { mockAnalysisWindows } from "../dev/mock/analysis";
import { mockRuns } from "../dev/mock/runs";
import { extendMock, mockTauri } from "../test/tauri";
import { getCommand, runCommand, unavailableReason } from "../lib/commands";
import { holdModal, MODAL_REASON } from "../lib/overlays";
import { editorFeedback } from "../editor";
import { analysisOf, resetSilentAnalysis } from "../panes/status/analysis";
import { getRunState, onRunFinished, onRunOutput, startRun, stopRun } from "../runs/state";
import { openPath } from "../workspace/files/documents";
import { activeTab, addTab, tabById } from "../workspace/store";
import { reportsReachTheShell, showReport } from "./report";
import { useAnalysisCommands } from "./index";
import { analysisWords as w } from "./words";

const resaved = import.meta.glob("../../golden/*/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const golden = import.meta.glob("../../golden/{2dtandem,OpenJackson.d2.feedback.p50.inf}/{analysis,primitives}.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const goldenText = (e: string, f: string) => golden[`../../golden/${e}/${f}`];

afterEach(() => resetSilentAnalysis());

/** An example as Rust's reader hands it over: 0.90.34's own re-save of it. */
function exampleDocument(stem: string) {
  return JSON.parse(resaved[`../../golden/${stem}/resave.bnet`]);
}

function openExample(stem: string): string {
  return addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: exampleDocument(stem) });
}

function Commands() {
  useAnalysisCommands();
  return null;
}

function setup() {
  mockTauri(defaultHandlers({ files: { "/networks/2dtandem.bnet": JSON.stringify(exampleDocument("2dtandem")) } }));
  render(<Commands />);
}

const log = (id: string) => tabById(id)!.log.map((l) => l.text);
const entry = (id: string, text: string) => tabById(id)!.log.find((l) => l.text === text);
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the Network menu's analysis commands", () => {
  it("are registered under the menu's ids with 0.90.34's tooltips (MENU-086…088, ANA-138, ANA-171, ANA-192, ANA-238)", () => {
    setup();
    expect(getCommand("network:analyze")).toMatchObject({ title: "Analyze Network", subtitle: "Check the network for stability, tractability and structural problems" });
    expect(getCommand("network:primitives")).toMatchObject({ title: "Show Network Primitives", subtitle: "Print the SRBM primitives (drift, covariance, reflection) to the shell" });
    expect(getCommand("network:model")?.subtitle).toBe("Inspect a non-spatial node and route outline, or compare finite-buffer blocking rules");
    expect(getCommand("run:choose-method")?.subtitle).toBe("Compare applicability, assumptions, model layer, outputs and expected cost for this network");
    expect(getCommand("help:check-dependencies")?.subtitle).toBe("Re-run the startup checklist: Python, optional modules, and the bundled solvers");
  });

  it("wait for a network and for a sheet to close; Check Dependencies… never waits", () => {
    setup();
    for (const id of ["network:analyze", "network:primitives", "network:model", "run:choose-method"]) expect(unavailableReason(getCommand(id)!)).toBe("Draw or open a network first");
    openExample("2dtandem");
    for (const id of ["network:analyze", "network:primitives", "network:model", "run:choose-method"]) expect(unavailableReason(getCommand(id)!)).toBeNull();
    const release = holdModal();
    for (const id of ["network:analyze", "network:primitives", "network:model", "run:choose-method"]) expect(unavailableReason(getCommand(id)!)).toBe(MODAL_REASON);
    expect(unavailableReason(getCommand("help:check-dependencies")!)).toBeNull();
    release();
  });
});

describe("Analyze Network", () => {
  it("logs the ρ line, shows 0.90.34's report through the run path and says so (ANA-140, ANA-142)", async () => {
    setup();
    const id = openExample("2dtandem");
    expect(await runCommand("network:analyze")).toBe(true);
    await tick();
    expect(log(id), JSON.stringify(log(id))).toContain("Analyze Network ρ (data.alpha/data.capacity):  S1 α=1.0000 c=1.0000 ρ=1.0000  S2 α=1.0000 c=1.0000 ρ=1.0000");
    expect(log(id).at(-1)).toBe(w.displayedAnalysis);
    // 0.90.34's text, but for ANA-154's restored "~10%.", and nothing normalised.
    const shown = mockAnalysisWindows.shown[0];
    expect(shown).toMatchObject({ tabId: id, kind: "analyze" });
    expect(shown.report).toBe(goldenText("2dtandem", "analysis.txt").replace(/usually within ~10$/gm, "usually within ~10%."));
  });

  it("leaves the flags, warnings and tractability alone (ANA-141)", async () => {
    setup();
    const id = openExample("2dtandem");
    await showReport("analyze", id);
    expect(analysisOf(id)).toBeNull();
  });

  it("reports a network without a station model as reportBlocked did (ANA-139)", async () => {
    setup();
    extendMock({ analysis_report: () => ({ failed: "Analyze network aborted: The network has no sink node.", status: [], report: "", analysis: null }) });
    const id = openExample("2dtandem");
    expect(await showReport("analyze", id)).toBe(false);
    expect(entry(id, "Analyze network aborted: The network has no sink node.")?.severity).toBe("error");
    expect(mockAnalysisWindows.shown).toHaveLength(0);
  });
});

describe("Show Network Primitives", () => {
  it("publishes its analysis as the tab's flags, then logs its diagnostics and shows the report (ANA-173…175)", async () => {
    setup();
    const id = openExample("OpenJackson.d2.feedback.p50.inf");
    expect(await showReport("primitives", id)).toBe(true);
    await tick();
    expect(analysisOf(id)?.outcome).toBe("analysed");
    expect(log(id)).toContain("Primitives ρ:  S1[α=2.0000,μ=2.8571,ρ=0.7000]  S2[α=1.0000,μ=1.4286,ρ=0.7000]");
    expect(log(id)).toContain("  class 1 α·μ per station:  [2.000/2.857]  [1.000/1.429]");
    expect(log(id).at(-1)).toBe(w.displayedPrimitives);
    expect(mockAnalysisWindows.shown[0].report).toContain("throughput-weighted (harmonic) service rate");
  });

  it("runs after every successful open (ANA-028, WS-111)", async () => {
    setup();
    expect(await openPath("/networks/2dtandem.bnet")).toBe(true);
    await tick();
    await tick();
    const id = activeTab().id;
    expect(mockAnalysisWindows.shown.map((s) => [s.tabId, s.kind])).toEqual([[id, "primitives"]]);
    expect(log(id).at(-1)).toBe(w.displayedPrimitives);
  });

  it("is refused while a run is active, with the registry's sentence and a beep (ANA-143, ANA-175, RUN-045)", async () => {
    setup();
    const beep = vi.spyOn(editorFeedback, "beep");
    mockRuns.replayMs = 10_000;
    try {
      const a = openExample("5stationtandem.inf");
      const b = openExample("2dtandem");
      expect(await startRun(a, "qna")).toBe(true);
      expect(await showReport("primitives", b)).toBe(false);
      expect(log(b)).toContain("Network Primitives was not started because QNA is already running for “5stationtandem.inf.bnet”. Stop or wait for that run first.");
      expect(log(b)).not.toContain(w.displayedPrimitives);
      expect(beep).toHaveBeenCalledTimes(1);
      await stopRun();
    } finally {
      mockRuns.replayMs = 120;
      beep.mockRestore();
    }
  });

  it.skipIf(!reportsReachTheShell())("reaches the Shell pane through onRunOutput as the run `primitives`, and ends as a run (RUN-045)", async () => {
    setup();
    const id = openExample("2dtandem");
    const chunks: Uint8Array[] = [];
    const methods: string[] = [];
    const stop = onRunOutput((b, meta) => {
      chunks.push(b);
      methods.push(meta.method);
    });
    const done = new Promise<void>((resolve) => {
      const off = onRunFinished(() => {
        off();
        resolve();
      });
    });
    await showReport("primitives", id);
    await done;
    stop();
    const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
    expect(text).toBe(mockAnalysisWindows.shown[0].report);
    expect(new Set(methods)).toEqual(new Set(["primitives"]));
    expect(getRunState().last).toMatchObject({ summary: "Network Primitives finished in 0.0 s", recordId: null });
  });
});
