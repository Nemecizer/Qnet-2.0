// The startup dependency check against the mock backend (ledger ANA-237…255, MENU-162): one row at
// a time in catalog order, once per session, Recheck, the launch rule, and the sheet's words.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../dev/mockBackend";
import { mockAnalysisWindows } from "../dev/mock/analysis";
import { mockCalls, mockTauri } from "../test/tauri";
import type { DependencyResult } from "../lib/types";
import {
  brewInstallCommand,
  checkTiming,
  commandText,
  getCheckState,
  openDependencyCheck,
  rerun,
  resetDependencyCheck,
  runIfNeeded,
  startupDependencyCheck,
  supplementalCommands,
} from "./deps";
import { footerSummary, headerSubtitle, StartupCheckView } from "./StartupCheck";

beforeEach(() => {
  checkTiming.minimumVisibleMs = 0;
  mockTauri(defaultHandlers());
});
afterEach(() => {
  resetDependencyCheck();
  checkTiming.minimumVisibleMs = 180;
});

const probes = () => mockCalls.filter((c) => c.cmd === "dependency_probe").map((c) => c.args.id);
const missing = (ids: string[], detail = "not here"): ((id: string) => DependencyResult) => (id) => (ids.includes(id) ? { state: "missing", detail } : { state: "available", detail: `${id} ok` });

describe("the checks", () => {
  it("run one at a time in catalog order, once per session; Recheck runs them all again (ANA-249)", async () => {
    await runIfNeeded();
    const order = ["developer.xcode-tools", "developer.cmake", "runtime.python", "optional.numpy", "optional.cvxpy", "developer.solver-libraries"];
    expect(probes()).toEqual(order);
    expect(getCheckState()).toMatchObject({ hasRun: true, running: false, currentId: null, lastCheckedId: "developer.solver-libraries" });
    await runIfNeeded();
    expect(probes()).toHaveLength(6);
    await rerun();
    expect(probes()).toEqual([...order, ...order]);
  });

  it("show each row as checking for at least 180 ms (ANA-249)", async () => {
    checkTiming.minimumVisibleMs = 180;
    mockAnalysisWindows.catalog = { packaged: true, items: mockAnalysisWindows.catalog.items.slice(2, 4) };
    const started = Date.now();
    const done = runIfNeeded();
    await waitFor(() => expect(getCheckState().currentId).toBe("runtime.python"));
    expect(getCheckState().items[0].status.state).toBe("checking");
    await done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("make one de-duplicated brew line from the rows that need attention, plus the other commands (ANA-250)", async () => {
    mockAnalysisWindows.probe = missing(["developer.cmake", "runtime.python", "optional.cvxpy", "developer.solver-libraries"]);
    await runIfNeeded();
    expect(brewInstallCommand()).toBe("brew install cmake python");
    expect(supplementalCommands()).toEqual(["python3 -m pip install cvxpy", "bash scripts/build-deps.sh"]);
    expect(commandText()).toBe("brew install cmake python\npython3 -m pip install cvxpy\nbash scripts/build-deps.sh");
  });

  it("ask a developer for the build tools and the built libraries, never for a Homebrew library or gcc", async () => {
    mockAnalysisWindows.probe = missing(mockAnalysisWindows.catalog.items.map((i) => i.id));
    await runIfNeeded();
    expect(commandText()).toBe("brew install cmake python numpy\nxcode-select --install\npython3 -m pip install cvxpy\nbash scripts/build-deps.sh");
  });
});

describe("when the checklist shows", () => {
  it("opens at launch for a source-tree run (ANA-237)", async () => {
    expect(await startupDependencyCheck()).toBe(true);
    expect(getCheckState().open).toBe(true);
  });

  it("never at launch for a packaged app; Help ▸ Check Dependencies… opens it any time (ANA-237, ANA-238, MENU-162)", async () => {
    mockAnalysisWindows.catalog = { ...mockAnalysisWindows.catalog, packaged: true };
    expect(await startupDependencyCheck()).toBe(false);
    expect(getCheckState().open).toBe(false);
    openDependencyCheck();
    expect(getCheckState().open).toBe(true);
  });
});

describe("the sheet", () => {
  it("says what it is checking, then how it ended, with each row's scope and status (ANA-251…253, ANA-255)", async () => {
    mockAnalysisWindows.probe = missing(["optional.cvxpy"], "CVXPY has no supported SDP solver");
    render(<StartupCheckView />);
    expect(screen.getByRole("heading", { name: "Qnet Startup Check" })).toBeInTheDocument();
    await waitFor(() => expect(getCheckState().hasRun).toBe(true));
    expect(screen.getByText("1 item need attention.")).toBeInTheDocument();
    expect(screen.getByText("Startup check complete with notes")).toBeInTheDocument();
    expect(screen.getByText("Green checkmarks identify packages and bundled components that are ready.")).toBeInTheDocument();
    const cvx = screen.getByRole("listitem", { name: /^CVXPY with an SDP solver, Optional/ });
    expect(within(cvx).getByText("Missing — CVXPY has no supported SDP solver")).toBeInTheDocument();
    expect(within(cvx).getByText("Adds numerical candidates for general BAR moment bounds; exact BAR cases work without it.")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: /^CMake, Developer/ })).getByText("developer.cmake ok")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: /^Solver libraries, Developer/ })).getByText(/built from their pinned sources by scripts\/build-deps\.sh/)).toBeInTheDocument();
    expect(screen.getByText("5 ready; 1 need attention. Optional items do not prevent Qnet from opening.")).toBeInTheDocument();
    // CVXPY alone: the Python command and its note.
    expect(screen.getByText("Install missing packages")).toBeInTheDocument();
    expect(screen.getByText("Open Terminal in Qnet's source folder and run the commands shown below. Optional rows only unlock the method named in that row. Relaunch Qnet afterwards.")).toBeInTheDocument();
    expect(screen.getByText("python3 -m pip install cvxpy")).toBeInTheDocument();
    expect(screen.getByText("Commands that are not Homebrew formulas (Apple's tools, a Python package, Qnet's own build script) are shown on their own lines above.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
  });

  it("all ready: no guidance, and the count of checks passed (ANA-251, ANA-255)", async () => {
    render(<StartupCheckView />);
    await waitFor(() => expect(getCheckState().hasRun).toBe(true));
    expect(screen.getByText("Every checked dependency is ready.")).toBeInTheDocument();
    expect(screen.getByText("Startup check complete")).toBeInTheDocument();
    expect(screen.getByText("6 of 6 checks passed.")).toBeInTheDocument();
    expect(screen.queryByText("Install missing packages")).toBeNull();
  });

  it("asks to repair a packaged app whose bundled solver can't launch, with no command to run (ANA-254)", async () => {
    mockAnalysisWindows.catalog = { packaged: true, items: [{ id: "bundled.rqna", scope: "Bundled", brewFormulae: [], supplementalInstallCommands: [] }] };
    mockAnalysisWindows.probe = missing(["bundled.rqna"], "This Qnet.app does not contain a loadable bna_rqna component.");
    render(<StartupCheckView />);
    await waitFor(() => expect(getCheckState().hasRun).toBe(true));
    expect(screen.getByText("Repair this Qnet app")).toBeInTheDocument();
    expect(screen.getByText(/^This Qnet.app is incomplete or contains a component that cannot launch/)).toBeInTheDocument();
    expect(screen.getByText("A packaged Qnet.app needs nothing installed: its Python, solvers and libraries are inside it.")).toBeInTheDocument();
    expect(document.querySelector(".dc-command")).toBeNull();
    act(() => resetDependencyCheck());
  });

  it("keeps Continue disabled while checking, and Recheck starts over (ANA-255)", async () => {
    checkTiming.minimumVisibleMs = 60;
    openDependencyCheck();
    render(<StartupCheckView />);
    await waitFor(() => expect(getCheckState().running).toBe(true));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(footerSummary(getCheckState())).toBe("Checking packages…");
    expect(headerSubtitle(getCheckState())).toMatch(/^Checking .+…$/);
    await waitFor(() => expect(getCheckState().hasRun).toBe(true), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(getCheckState().running).toBe(true));
    expect(getCheckState().items.some((i) => i.status.state === "pending")).toBe(true);
    await waitFor(() => expect(getCheckState().hasRun).toBe(true), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(getCheckState().open).toBe(false);
  });
});
