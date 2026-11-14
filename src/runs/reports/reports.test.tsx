// Failure reports (src/runs/reports, new in 2.0): the explanation chosen from a report's evidence,
// the Status line's "Show Report…", the panel and its buttons, Copy Report's text, and Help ▸ Show
// Failure Reports…. The evidence strings are the solvers' and the runner's own (see words.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockInfo } from "../../dev/mock/core";
import { mockReports, sampleReport } from "../../dev/mock/reports";
import { mockRuns } from "../../dev/mock/runs";
import { getCommand, registerCommands, runCommand, unavailableReason } from "../../lib/commands";
import { loadKv, resetKv } from "../../lib/kv";
import { MENU_SPEC, type SpecEntry } from "../../lib/menuSpec";
import { resetOverlays } from "../../lib/overlays";
import { isPanelOpen } from "../../lib/panel";
import type { RunMessage } from "../../lib/types";
import { resetStatusActions, statusAction } from "../../panes/status/actions";
import { StatusPane } from "../../panes/status";
import { resetPaneStates } from "../../panes/status/state";
import { channelSend, extendMock, mockCalls, mockTauri } from "../../test/tauri";
import { addTab, getWorkspace, resetWorkspace, selectTab, tabById } from "../../workspace/store";
import { getRunState, resetRuns, startRun, stopRun } from "../state";
import { runCommands, resetRunCommands } from "../ui/commands";
import { FailureReportHost, reportTiming, alternativeFor, closeReport, explain, lastErrorLine, latestReport, openReport, reportCommands, reportText, reportWords as w, resetReports, tooLarge, withoutHome } from "./index";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const openExample = (stem: string) => addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: JSON.parse(examples[`../../../examples/${stem}.bnet`]) });

/** Every item of a menu spec, submenus included. */
function specItems(entries: SpecEntry[], out: { id: string; label: string }[] = []) {
  for (const e of entries) {
    if (e === "-" || "header" in e || "predefined" in e || "dynamic" in e) continue;
    if ("submenu" in e) specItems(e.items, out);
    else out.push(e);
  }
  return out;
}

const frames: HTMLIFrameElement[] = [];
let opened: { name: string; win: Window }[] = [];
let unregister: (() => void)[] = [];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetRuns();
  resetReports();
  resetStatusActions();
  resetPaneStates();
  resetOverlays();
  resetRunCommands();
  mockRuns.replayMs = 30;
  unregister = [registerCommands(runCommands()), registerCommands(reportCommands())];
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
  if (getRunState().active) await act(async () => void (await stopRun()));
  await new Promise((r) => setTimeout(r, 0));
  unregister.forEach((u) => u());
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

const panel = () => {
  const o = [...opened].reverse().find((x) => x.name === "qnet-panel-failure-report");
  if (!o) throw new Error("no failure-report panel");
  return within(o.win.document.body);
};
const logOf = (id: string) => tabById(id)!.log.map((l) => l.text);

/** A run that the backend fails: its Status lines, the report, then `finished`. */
function failingRun(messages: RunMessage[]) {
  extendMock({
    run_start: ({ channel }: { channel: unknown }) => {
      for (const m of messages) channelSend(channel, m);
      return { started: true };
    },
  });
}
const finishedFailed = (summary: string, exitCode = 1, filed: "failed" | null = "failed"): RunMessage => ({ kind: "finished", summary, statusBar: summary, exitCode, userStopped: false, succeeded: exitCode === 0, recordId: null, filed, filedReason: null });

describe("the explanation (words.ts)", () => {
  it("a solver ended by a signal is a fault in Qnet, with another method to try", () => {
    const e = explain(sampleReport({ kind: "signal", signal: "SIGSEGV", exitCode: 139, outputTail: "", commands: [] }));
    expect(e.cause).toBe("crash");
    expect(e.title).toBe("The solver stopped unexpectedly (SIGSEGV).");
    expect(e.body).toBe("This is a fault in Qnet, not in your network. Nothing you entered is wrong, and your network has not been changed.");
    expect(e.tryMethod).toEqual({ command: "run:qna", name: "Whitt QNA" });
    expect(e.next).toEqual(["Run Whitt QNA instead: it does not use the part that failed.", w.sendReport]);
    // A crash stays a crash whatever else the output says.
    expect(explain(sampleReport({ kind: "signal", signal: "SIGABRT", stderrTail: "srbm: malloc failed for 99 bytes\n" })).cause).toBe("crash");
    // Qnet's own run thread ending is the same kind of fault.
    const internal = explain(sampleReport({ kind: "internal", exitCode: -1, statusLines: [{ severity: "error", text: "Linear Program stopped on an internal error: index out of bounds" }], outputTail: "" }));
    expect(internal.cause).toBe("internal");
    expect(internal.title).toBe("Linear Program stopped on an internal error.");
    expect(internal.body).toMatch(/^This is a fault in Qnet, not in your network\./);
    expect(internal.detail).toBe("Linear Program stopped on an internal error: index out of bounds");
  });

  it("out of memory and the solvers' memory guard say to make the problem smaller, per method", () => {
    const guard = "\nERROR: requested allocation exceeds the memory budget.\n  data structure   : spectral system matrix\n  requested        : 91.20 GB\n";
    const e = explain(sampleReport({ method: "inf_sm", methodName: "Spectral", exitCode: 2, stderrTail: guard, outputTail: "" }));
    expect(e.cause).toBe("memory");
    expect(e.title).toBe("Spectral needs more memory than this Mac can give it.");
    expect(e.next[0]).toBe("Lower the polynomial degree in Run Spectral Method… (the memory needed grows very quickly with the degree and the number of stations).");
    expect(e.next[1]).toBe("Run Whitt QNA instead: it does not use the part that failed.");
    expect(e.detail).toBe("requested        : 91.20 GB");
    for (const said of ["bna_sbd: out of memory in solve_subnetwork (n=40)", "Error: Failed to allocate DMAT data (9000 x 9000)", "srbm: malloc failed for 123456789 bytes", "allocation failure 1 in dmatrix()", "MemoryError", "out of memory growing the chain"]) {
      expect(explain(sampleReport({ stderrTail: said + "\n" })).cause, said).toBe("memory");
    }
    expect(explain(sampleReport({ method: "fm", methodName: "Finite Element", infiniteBuffers: false, stderrTail: "Error: out of memory\n" })).next).toEqual([
      "Use a smaller mesh size in Run Finite Element… (the memory needed grows very quickly with the mesh size and the number of stations).",
      "Run Monte Carlo instead: it does not use the part that failed.",
    ]);
    expect(explain(sampleReport({ stderrTail: "Error: out of memory\n" })).next[0]).toBe("Use a smaller grid size for the Linear Program (Settings ▸ Linear Program).");
    expect(explain(sampleReport({ method: "generic_ctmc", infiniteBuffers: false, stderrTail: "out of memory enumerating states\n" })).next[0]).toMatch(/^This network has too many states/);
  });

  it("an infinite-buffer network with utilisation of 1 or more is unstable, naming the station and its rate", () => {
    const e = explain(sampleReport({ method: "inf_sm", methodName: "Spectral", utilisation: [{ station: "S1", utilisation: 0.7 }, { station: "Packing", utilisation: 1.0499 }], stderrTail: "bnet: singular system\n" }));
    expect(e.cause).toBe("unstable");
    expect(e.title).toBe("The network is unstable.");
    expect(e.body).toBe("Station Packing has utilisation 1.05: work arrives faster than it can be served, so the queue there grows without limit and there is no steady state for Spectral to compute. With infinite buffers every method needs utilisation below 1 at every station.");
    expect(e.next[0]).toBe("Check Packing's service rate and number of servers against its arrival rate: utilisation (arrival rate ÷ total service rate) must be below 1.");
    expect(e.next[1]).toBe("Or change Buffer Model to Finite, where a full station blocks or loses customers instead of growing.");
    // No other method helps an unstable network.
    expect(e.tryMethod).toBeNull();
    // Several stations, worst first.
    expect(explain(sampleReport({ utilisation: [{ station: "S1", utilisation: 1 }, { station: "S2", utilisation: 1.5 }] })).body).toMatch(/^Stations S2 \(1\.50\), S1 \(1\.00\) have utilisation of 1 or more/);
    // The product-form solver's own sentence, when Qnet's ρ is not at hand.
    const said = explain(sampleReport({ method: "product_form", methodName: "Product Form", utilisation: [], stderrTail: "error: station 'S1' is unstable: open offered load 1.2 >= 1\n" }));
    expect(said.cause).toBe("unstable");
    expect(said.body).toMatch(/^At least one station receives work faster than it can serve it, so/);
    // Finite buffers need no stability: ρ ≥ 1 there is not the cause.
    expect(explain(sampleReport({ method: "sm", infiniteBuffers: false, utilisation: [{ station: "S1", utilisation: 1.4 }] })).cause).toBe("other");
  });

  it("a network too large for mc_solver says what does work: the Method Chooser's methods, the chooser itself, and the mesh that fits", () => {
    // mc_solver's own words (solvers/infinite/BNAmd/src/mc_fem_gauss.c), five stations at mesh 8.
    const stderr =
      "mc_solver: this network is too large for the multi-class finite-element solver at this mesh.\n" +
      "  5 stations with 8 mesh elements per station need 34,359,738,368 matrix entries; the solver can hold at most 2,147,483,647.\n" +
      '  A mesh of 4 or fewer elements per station fits (option -n 4; in Qnet, "Mesh size per dimension" in Run Multi-Class SRBM). A coarser mesh is less accurate and can still need a lot of memory and time.\n';
    const r = sampleReport({ method: "mc", methodName: "Multi-class SRBM", stderrTail: stderr });
    expect(tooLarge(r)).toBe(true);
    const advised = [
      { command: "run:monte-carlo-infinite", name: "Monte Carlo" },
      { command: "run:multiclass", name: "Multi-Class SRBM" },
      { command: "run:qna", name: "Whitt QNA" },
      { command: "run:rqna", name: "Whitt–You RQNA" },
      { command: "run:sbd", name: "Sequential Bottleneck Decomposition" },
    ];
    const e = explain(r, advised);
    expect(e.cause).toBe("too-large");
    expect(e.title).toBe("This network is too large for Multi-class SRBM.");
    expect(e.body).toBe("Multi-class SRBM solves on a mesh over all the stations at once, and the mesh grows very quickly with their number: with 5 stations it needs more matrix entries than the solver can hold at the mesh it was given. Your network is valid, and other methods solve it.");
    expect(e.next).toEqual([
      "For this network Qnet's Method Chooser recommends Monte Carlo, Whitt QNA or Whitt–You RQNA. They do not build the mesh that was too large.",
      "Run ▸ Choose a Method… lists every method with whether it applies to this network, and why.",
      'Or run Multi-Class SRBM again with a coarser mesh: 4 or fewer elements per station ("Mesh size per dimension" in Run Multi-Class SRBM…). A coarser mesh is less accurate and can still need a lot of memory and time.',
    ]);
    expect(e.tryMethod).toEqual({ command: "run:monte-carlo-infinite", name: "Monte Carlo" });
    // The error itself stays: the solver's last line is the detail.
    expect(e.detail).toContain("A mesh of 4 or fewer elements per station fits");
    // Without the chooser's answer: the standing alternative, and the chooser to look in.
    const bare = explain(r);
    expect(bare.next.slice(0, 2)).toEqual(["Run Whitt QNA instead: it does not use the part that failed.", w.chooser]);
    expect(bare.tryMethod).toEqual({ command: "run:qna", name: "Whitt QNA" });
    // No mesh fits: no mesh is suggested.
    const none = explain(sampleReport({ method: "mc", methodName: "Multi-class SRBM", stderrTail: stderr.split("\n").slice(0, 2).join("\n") + "\n  No mesh is small enough for 8 stations. Use a method made for larger networks, such as QNA or simulation.\n" }), advised);
    expect(none.next).toHaveLength(2);
    expect(none.body).toContain("whatever the mesh");
    // Other failures are untouched by the chooser's list.
    expect(tooLarge(sampleReport({ stderrTail: "srbm: malloc failed for 99 bytes" }))).toBe(false);
    expect(explain(sampleReport({ method: "lp", stderrTail: "srbm: malloc failed for 99 bytes" }), advised).cause).toBe("memory");
  });

  it("a missing Python module names the module and points at Check Dependencies", () => {
    const trace = 'Traceback (most recent call last):\n  File "solver.py", line 12, in <module>\n    import numpy as np\nModuleNotFoundError: No module named \'numpy\'\n';
    const e = explain(sampleReport({ method: "adaptive_bar", methodName: "Adaptive Bar", stderrTail: trace, outputTail: "" }));
    expect(e.cause).toBe("missing-module");
    expect(e.title).toBe("Python is missing the module “numpy”.");
    expect(e.body).toBe("Adaptive Bar is written in Python and needs the module “numpy” that the Python Qnet used does not have. Your network is not the problem.");
    expect(e.next).toEqual([w.checkDependencies, "Run Whitt QNA instead: it does not use the part that failed."]);
    expect(e.detail).toBe("ModuleNotFoundError: No module named 'numpy'");
    expect(explain(sampleReport({ stderrTail: "ImportError: cannot import name 'linprog' from 'scipy.optimize'\n" })).title).toBe("Python could not load a module this method needs.");
  });

  it("a solver that reports non-convergence says so", () => {
    const e = explain(sampleReport({ method: "generic_ctmc", methodName: "Generic Ctmc", infiniteBuffers: false, stderrTail: "error: stationary iteration did not converge; increase max_iterations\n" }));
    expect(e.cause).toBe("no-convergence");
    expect(e.title).toBe("Generic Ctmc did not converge.");
    expect(e.tryMethod).toEqual({ command: "run:monte-carlo-finite", name: "Monte Carlo" });
    expect(e.next[1]).toBe("Run Monte Carlo instead: it does not use the part that failed.");
    for (const said of ["Status: NOT CONVERGED", "reason: rate_matrix_not_converged", "LP iteration DIVERGED"]) expect(explain(sampleReport({ outputTail: said + "\n" })).cause, said).toBe("no-convergence");
  });

  it("a solver that could not start, and output that could not be used", () => {
    const e = explain(sampleReport({ kind: "could-not-start", exitCode: -1, outputTail: "", commands: [], statusLines: [{ severity: "error", text: "Linear Program could not start: No such file or directory (os error 2)" }] }));
    expect(e.cause).toBe("could-not-start");
    expect(e.title).toBe("Linear Program could not start.");
    expect(e.detail).toBe("Linear Program could not start: No such file or directory (os error 2)");
    expect(e.next[0]).toBe(w.checkDependencies);

    const reason = "The solver exited successfully but produced no output. No performance measures can be trusted from this run.";
    const u = explain(sampleReport({ kind: "unparsed", exitCode: 0, reason, outputTail: "", statusLines: [] }));
    expect(u.cause).toBe("unusable-output");
    expect(u.title).toBe("Linear Program finished, but gave no usable result.");
    expect(u.body).toBe(reason);
  });

  it("anything else is the solver's last error line, never a heading", () => {
    const r = sampleReport();
    expect(lastErrorLine(r)).toBe("srbm_lp: the LP solver reported an infeasible problem");
    const e = explain(r);
    expect(e.cause).toBe("other");
    expect(e.title).toBe("Linear Program stopped with an error (exit 1).");
    expect(e.body).toBe("The solver's last message was: srbm_lp: the LP solver reported an infeasible problem");
    // stderr wins over the output; the runner's headings are skipped.
    expect(lastErrorLine(sampleReport({ stderrTail: "bna_qna: singular traffic-rate matrix\n" }))).toBe("bna_qna: singular traffic-rate matrix");
    expect(lastErrorLine(sampleReport({ outputTail: "", statusLines: [{ severity: "error", text: "⚠ QNA failed (exit 3):" }, { severity: "error", text: "bna_qna: bad input" }, { severity: "error", text: "QNA failed (exit 3) after 0.1 s" }] }))).toBe("bna_qna: bad input");
    expect(explain(sampleReport({ outputTail: "Solver exited with code 1.\n", statusLines: [] })).body).toBe("The solver gave no reason.");
  });

  it("names an alternative the network's Run menu has, by its menu title", () => {
    const titles = new Map(specItems(MENU_SPEC).map((i) => [i.id, i.label] as const));
    for (const [method, infinite] of [["inf_sm", true], ["qna", true], ["rqna", true], ["lp", true], ["regenerative_mc", true], ["mc", true], ["sm", false], ["sim", false], ["fm", false], ["regenerative_mc", false]] as const) {
      const alt = alternativeFor(method, infinite)!;
      expect(titles.get(alt.command)?.replace(/^Run /, "").replace(/…$/, ""), `${method} ${infinite}`).toBe(alt.name);
      // The other buffer mode's commands are never offered.
      expect(alt.command.endsWith("-finite") || alt.command === "run:decomposition").toBe(!infinite);
    }
    expect(alternativeFor("qna", true)!.command).toBe("run:monte-carlo-infinite");
    expect(alternativeFor("sim", false)!.command).toBe("run:decomposition");
    // A comparison already runs every method.
    expect(alternativeFor("inf_cmp", true)).toBeNull();
    expect(alternativeFor("cmp", false)).toBeNull();
  });
});

describe("Copy Report's text", () => {
  it("summarises the failure for an email or an issue, with no home-folder path", () => {
    const home = "/Users/jana";
    const r = sampleReport({
      seed: 42,
      runtime: `bundled: Contents/Resources/bin/BNAlp/srbm_lp; Python runtime: ${home}/miniconda3/bin/python3`,
      stderrTail: `srbm_lp: cannot open ${home}/Documents/Networks/out.csv\n`,
      outputTail: `reading ${home}/Library/Caches/x\nSolver exited with code 1.\n`,
      folder: `${home}/Library/Application Support/com.nemecj.qnet/reports/20261112-143005-lp`,
    });
    const text = reportText(r);
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("jana");
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Qnet failure report: Linear Program for “2dtandem.bnet”",
      "",
      "Linear Program stopped with an error (exit 1).",
      "The solver's last message was: srbm_lp: cannot open ~/Documents/Networks/out.csv",
    ]);
    expect(text).toContain(`Qnet ${mockInfo.version} (preview) · macOS 15.5 · Apple M3 Ultra\n`);
    expect(text).toContain("Method: Linear Program (lp), infinite buffers\n");
    expect(text).toContain("Ended: exit 1 after 12.3 s\n");
    expect(text).toContain("Settings: grid size = 12; basis size = 6; solver = automatic\n");
    expect(text).toContain("Seed: 42\n");
    expect(text).toContain("Command: Contents/Resources/bin/BNAlp/srbm_lp --input $TMPDIR/BNET_lp_77_s0.in → exit 1\n");
    expect(text).toContain("Runtime: bundled: Contents/Resources/bin/BNAlp/srbm_lp; Python runtime: ~/miniconda3/bin/python3\n");
    expect(text).toContain("Utilisation: S1 0.70, S2 0.80\n");
    expect(text).toContain("Report: 20261112-143005-lp (2026-11-12T14:30:05Z)\n");
    expect(text).toContain("Error output:\nsrbm_lp: cannot open ~/Documents/Networks/out.csv\n");
    expect(text).toContain("Last lines of output:\nreading ~/Library/Caches/x\nSolver exited with code 1.\n");
    // The folder itself is not in the text: it means nothing to whoever receives it.
    expect(text).not.toContain("Application Support");
    expect(withoutHome('open "/Users/a b/x" /home/pat/y /Users/Shared/z')).toBe('open "~ b/x" ~/y ~/z');
    // A whole name at a time: "ann" is never taken out of "anna".
    expect(withoutHome("/Users/ann /Users/anna/x /Users/ann/x /Users/ann.old/y /Users/ann")).toBe("~ ~/x ~/x ~/y ~");
    // Only the last 40 lines of each stream go in.
    const long = reportText(sampleReport({ outputTail: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" }));
    expect(long).toContain("\nline 161\n");
    expect(long).not.toContain("\nline 160\n");
  });
});

describe("a failed run's Status line", () => {
  it("gains Show Report…, which opens the panel; 0.90.34's sentence is unchanged", async () => {
    const id = openExample("5stationtandem.inf");
    mockReports.reports["20261112-143005-lp"] = sampleReport({ networkTitle: "5stationtandem.inf.bnet" });
    failingRun([
      { kind: "status", text: "Running Linear Program (BNAlp)...", severity: "info" },
      { kind: "status", text: "Linear Program failed (exit 1) after 12 s", severity: "error" },
      { kind: "report", id: "20261112-143005-lp", statusText: "Linear Program failed (exit 1) after 12 s" },
      finishedFailed("Linear Program failed (exit 1) after 12 s"),
    ]);
    render(
      <>
        <StatusPane />
        <FailureReportHost />
      </>,
    );
    const before = logOf(id).length;
    await act(async () => void (await startRun(id, "lp")));
    await waitFor(() => expect(getRunState().last?.kind).toBe("failure"));
    // The two lines the run wrote, word for word, and nothing added.
    expect(logOf(id).slice(before)).toEqual(["Running Linear Program (BNAlp)...", "Linear Program failed (exit 1) after 12 s"]);
    expect(latestReport(id)).toBe("20261112-143005-lp");

    const row = screen.getAllByRole("option").find((r) => r.textContent?.includes("Linear Program failed (exit 1)"))!;
    expect(row.querySelector(".status-row-text")!.textContent).toBe("Linear Program failed (exit 1) after 12 s");
    // Only the failure's line carries the action.
    expect(screen.getAllByRole("button", { name: "Show Report…" })).toHaveLength(1);
    expect(isPanelOpen("failure-report")).toBe(false);
    fireEvent.click(within(row).getByRole("button", { name: "Show Report…" }));
    await waitFor(() => expect(isPanelOpen("failure-report")).toBe(true));
    await waitFor(() => panel().getByText("Linear Program stopped with an error (exit 1)."));
    expect(panel().getByText("Linear Program for “5stationtandem.inf.bnet”")).toBeTruthy();
  });

  it("a run whose output could not be used gets one line to carry the action", async () => {
    const id = openExample("5stationtandem.inf");
    failingRun([
      { kind: "status", text: "Running QNA...", severity: "info" },
      { kind: "report", id: "20261112-150000-qna", statusText: null },
      finishedFailed("QNA finished in 0.1 s", 0),
    ]);
    const before = logOf(id).length;
    await act(async () => void (await startRun(id, "qna")));
    await waitFor(() => expect(getRunState().last).not.toBeNull());
    expect(logOf(id).slice(before)).toEqual(["Running QNA...", "QNA ended without a usable result."]);
    const entry = tabById(id)!.log.at(-1)!;
    expect(entry.severity).toBe("error");
    expect(statusAction(entry.id)?.label).toBe("Show Report…");
    // The line belongs to the tab that ran, also when another tab is in front.
    const other = openExample("2dtandem");
    selectTab(other);
    failingRun([{ kind: "status", text: "QNA failed (exit 2) after 0.1 s", severity: "error" }, { kind: "report", id: "20261112-150100-qna", statusText: "QNA failed (exit 2) after 0.1 s" }, finishedFailed("QNA failed (exit 2) after 0.1 s", 2)]);
    await act(async () => void (await startRun(id, "qna")));
    await waitFor(() => expect(latestReport(id)).toBe("20261112-150100-qna"));
    expect(statusAction(tabById(id)!.log.at(-1)!.id)).toBeDefined();
    expect(tabById(other)!.log.every((l) => !statusAction(l.id))).toBe(true);
  });
});

describe("the Failure Report panel", () => {
  async function show(over: Parameters<typeof sampleReport>[0] = {}, tabId = getWorkspace().activeId) {
    const r = sampleReport(over);
    mockReports.reports[r.id] = r;
    render(<FailureReportHost />);
    act(() => openReport(r.id, tabId));
    await waitFor(() => panel().getByRole("heading", { name: w.whatWasRun }));
    return r;
  }

  it("shows the explanation, what to try, what was run and the last lines of output", async () => {
    const r = await show({ method: "inf_sm", methodName: "Spectral", exitCode: 2, stderrTail: "\nERROR: requested allocation exceeds the memory budget.\n  requested        : 91.20 GB\n", outputTail: "  [done]    0.4s\n" });
    const p = panel();
    expect(p.getByRole("heading", { name: "Failure Report" })).toBeTruthy();
    expect(p.getByText("Spectral for “2dtandem.bnet”")).toBeTruthy();
    expect(p.getByRole("heading", { name: "Spectral needs more memory than this Mac can give it." })).toBeTruthy();
    const next = within(p.getByRole("region", { name: "What to try" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(next).toEqual(explain(r).next);
    const facts = p.getByRole("region", { name: "What was run" });
    expect(within(facts).getByText("Spectral, infinite buffers")).toBeTruthy();
    expect(within(facts).getByText("exit 2 after 12.3 s")).toBeTruthy();
    expect(within(facts).getByText("grid size = 12; basis size = 6; solver = automatic")).toBeTruthy();
    expect(within(facts).getByText("Contents/Resources/bin/BNAlp/srbm_lp --input $TMPDIR/BNET_lp_77_s0.in → exit 1")).toBeTruthy();
    expect(within(facts).getByText(`Qnet ${mockInfo.version} · macOS 15.5 · Apple M3 Ultra`)).toBeTruthy();
    expect(within(facts).getByText(r.folder)).toBeTruthy();
    expect(p.getByLabelText("Error output").textContent).toContain("exceeds the memory budget");
    expect(p.getByLabelText("Last lines of output", { selector: "pre" }).textContent).toBe("  [done]    0.4s\n");
    expect(p.getByText("Nothing is sent anywhere. The report stays on this Mac unless you send it.")).toBeTruthy();
    // Modeless: the Run menu stays live behind it.
    expect(unavailableReason(getCommand("help:failure-reports")!)).toBeNull();
  });

  it("Reveal in Finder shows the report's folder; Copy Report copies the summary", async () => {
    const r = await show();
    const p = panel();
    fireEvent.click(p.getByRole("button", { name: "Reveal in Finder" }));
    await waitFor(() => expect(mockReports.revealed).toEqual([r.id]));

    const win = opened.at(-1)!.win;
    let copiedText = "";
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void (copiedText = t) } });
    fireEvent.click(p.getByRole("button", { name: "Copy Report" }));
    await waitFor(() => expect(copiedText).toBe(reportText(r)));
    expect(copiedText).not.toMatch(/\/Users\//);
    await waitFor(() => p.getByRole("button", { name: "Copied" }));
  });

  it("Try <method> runs the suggested method for the tab that failed, and closes the panel", async () => {
    const id = openExample("5stationtandem.inf");
    const other = openExample("2dtandem");
    selectTab(other);
    await show({}, id);
    fireEvent.click(panel().getByRole("button", { name: "Try Whitt QNA" }));
    await waitFor(() => expect(mockRuns.starts.at(-1)?.method).toBe("qna"));
    expect(mockRuns.starts.at(-1)?.tabId).toBe(id);
    expect(getWorkspace().activeId).toBe(id);
    expect(isPanelOpen("failure-report")).toBe(false);
    await waitFor(() => expect(getRunState().active).toBeNull(), { timeout: 4000 });
  });

  it("for a network too large for mc_solver, asks the Method Chooser and offers its first method", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    await show({ method: "mc", methodName: "Multi-class SRBM", stderrTail: "mc_solver: this network is too large for the multi-class finite-element solver at this mesh.\n  5 stations with 8 mesh elements per station need 34,359,738,368 matrix entries; the solver can hold at most 2,147,483,647.\n" }, id);
    const p = panel();
    expect(p.getByRole("heading", { name: "This network is too large for Multi-class SRBM." })).toBeTruthy();
    const first = await waitFor(() => {
      const li = within(p.getByRole("region", { name: "What to try" })).getAllByRole("listitem")[0].textContent!;
      expect(li).toMatch(/^For this network Qnet's Method Chooser recommends /);
      return li;
    });
    expect(first).not.toContain("Multi-Class SRBM");
    const button = p.getByRole("button", { name: /^Try / });
    expect(first).toContain(button.textContent!.replace(/^Try /, ""));
    act(() => closeReport());
  });

  it("has no Try button when there is no concrete alternative, and says when a report is gone", async () => {
    await show({ utilisation: [{ station: "S1", utilisation: 1.2 }] });
    expect(panel().getByRole("heading", { name: "The network is unstable." })).toBeTruthy();
    expect(panel().queryByRole("button", { name: /^Try / })).toBeNull();
    fireEvent.click(panel().getByRole("button", { name: "Close" }));
    await waitFor(() => expect(isPanelOpen("failure-report")).toBe(false));

    act(() => openReport("20200101-000000-gone", getWorkspace().activeId));
    await waitFor(() => expect(panel().getByRole("alert").textContent).toBe("That failure report is no longer there. Qnet keeps the newest 20."));
    expect(panel().getByRole("button", { name: "Reveal in Finder" })).toHaveProperty("disabled", true);
    act(() => closeReport());
  });
});

describe("a report that is still being written", () => {
  const timing = { ...reportTiming };
  beforeEach(() => Object.assign(reportTiming, { retries: 3, retryMs: 5 }));
  afterEach(() => Object.assign(reportTiming, timing));
  const writing = { kind: "unavailable", message: "Qnet is still writing that failure report." };

  it("is asked for again until it is there", async () => {
    const r = sampleReport();
    let asked = 0;
    extendMock({
      report_get: () => {
        asked += 1;
        if (asked < 3) throw writing;
        return r;
      },
    });
    render(<FailureReportHost />);
    act(() => openReport(r.id, getWorkspace().activeId));
    await waitFor(() => panel().getByText("Reading the report…"));
    expect(panel().queryByRole("alert")).toBeNull();
    await waitFor(() => panel().getByRole("heading", { name: w.whatWasRun }));
    expect(asked).toBe(3);
    expect(panel().queryByRole("alert")).toBeNull();
  });

  it("says so when it never arrives, and stops asking when the panel closes", async () => {
    let asked = 0;
    extendMock({
      report_get: () => {
        asked += 1;
        throw writing;
      },
    });
    render(<FailureReportHost />);
    act(() => openReport("20261112-143005-lp", getWorkspace().activeId));
    await waitFor(() => expect(panel().getByRole("alert").textContent).toBe("Qnet could not finish writing that failure report."));
    expect(asked).toBe(4);
    expect(panel().getByRole("button", { name: "Reveal in Finder" })).toHaveProperty("disabled", true);
    act(() => closeReport());

    Object.assign(reportTiming, { retries: 100, retryMs: 5 });
    act(() => openReport("20261112-143006-lp", getWorkspace().activeId));
    await waitFor(() => expect(asked).toBeGreaterThan(5));
    act(() => closeReport());
    const then = asked;
    await new Promise((res) => setTimeout(res, 40));
    expect(asked).toBeLessThanOrEqual(then + 1);
  });
});

describe("Help ▸ Show Failure Reports…", () => {
  it("is in the Help menu and opens the reports folder", async () => {
    expect(specItems(MENU_SPEC).find((i) => i.id === "help:failure-reports")?.label).toBe("Show Failure Reports…");
    expect(getCommand("help:failure-reports")?.title).toBe("Show Failure Reports…");
    await runCommand("help:failure-reports");
    expect(mockReports.revealed).toEqual([null]);
    expect(mockCalls.filter((c) => c.cmd === "reports_reveal").at(-1)?.args).toEqual({ id: null });
    // A refusal is said, not swallowed.
    extendMock({ reports_reveal: () => Promise.reject({ kind: "failed", message: "Qnet couldn't ask Finder to show the folder." }) });
    await runCommand("help:failure-reports");
    expect(logOf(getWorkspace().activeId).at(-1)).toBe("Could not show the failure reports folder: Qnet couldn't ask Finder to show the folder.");
  });
});
