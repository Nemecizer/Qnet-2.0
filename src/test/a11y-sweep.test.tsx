// The accessibility sweep (ledger WF-601; docs/ACCESSIBILITY.md): each major view of the app is
// rendered against the simulated backend and put through the checker in ./a11y/check.ts — every
// control named, no id twice, every ARIA reference resolving, every dialog labelled, no bare SVG,
// no live region doubled. The checker has its own tests first, so a pass here means something.
//
// What this cannot see is said in docs/ACCESSIBILITY.md: colour (contrast.test.ts), layout and
// focus order (the browser preview), and what VoiceOver actually says (the manual script).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../App";
import { defaultHandlers } from "../dev/mockBackend";
import { mockReports, sampleReport } from "../dev/mock/reports";
import { mockRuns } from "../dev/mock/runs";
import { installExplainModel } from "../dev/mock/aiExplain";
import { activeEditor } from "../editor";
import { runCommand } from "../lib/commands";
import { loadKv } from "../lib/kv";
import { toast, dismissToast } from "../lib/toasts";
import { resetAdvice } from "../panes/results/agreement/chooser";
import { resetSequence } from "../panes/results/agreement/runner";
import { resetStructures } from "../results/current";
import { FailureReportHost } from "../runs/reports/ReportPanel";
import { openReport, resetReports } from "../runs/reports/state";
import { createScenario, openCompare } from "../scenarios/commands";
import { openFitPanel, closeFitPanel } from "../fit/store";
import { setDiagnosticsForTest } from "../canvas/validation/store";
import { resetTour } from "../tour/state";
import { startTandem } from "../welcome/starts";
import { activeTab } from "../workspace/store";
import { accessibleName, checkA11y, formatProblems, roleOf } from "./a11y/check";
import { mockTauri } from "./tauri";

const WAIT = { timeout: 15000 };
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

// ── The checker itself ───────────────────────────────────────────────────────────────────────

function problemsOf(html: string, skip: string[] = ["lang"]): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    return checkA11y(host, { skip }).map((p) => p.rule);
  } finally {
    host.remove();
  }
}

describe("the checker", () => {
  it("passes a well-made form", () => {
    expect(
      problemsOf(`
        <h2 id="t">Title</h2>
        <div role="dialog" aria-labelledby="t">
          <label>Name <input type="text"></label>
          <label for="n">Count</label><input id="n" type="number">
          <button type="button"><svg aria-hidden="true"></svg> Save</button>
          <button type="button" aria-label="Close"><svg aria-hidden="true"></svg></button>
          <div role="radiogroup" aria-label="Mode"><button role="radio" aria-checked="true">A</button><button role="radio" aria-checked="false">B</button></div>
          <svg role="img" aria-label="A chart"></svg>
          <table><tr><th>A</th></tr><tr><td>1</td></tr></table>
          <select aria-label="Sort"><option>x</option></select>
          <div role="status">Saved</div>
        </div>`),
    ).toEqual([]);
  });

  it.each([
    ["a button with only an icon", `<button type="button"><svg aria-hidden="true"></svg></button>`, "control-name"],
    ["a field with no label", `<input type="text">`, "control-name"],
    ["a select with no label", `<select><option>x</option></select>`, "control-name"],
    ["a link with no text", `<a href="#x"></a>`, "control-name"],
    ["an unlabelled dialog", `<div role="dialog"><p>Hello</p></div>`, "dialog-name"],
    ["an id used twice", `<p id="dup-x">a</p><p id="dup-x">b</p>`, "duplicate-id"],
    ["aria-labelledby to nothing", `<div role="group" aria-labelledby="nowhere-1"></div>`, "aria-reference"],
    ["aria-describedby to nothing", `<button aria-describedby="nowhere-2">Go</button>`, "aria-reference"],
    ["aria-controls to nothing while expanded", `<button aria-expanded="true" aria-controls="nowhere-3">Go</button>`, "aria-reference"],
    ["a label for nothing", `<label for="nowhere-4">Name</label>`, "aria-reference"],
    ["a bare svg", `<p><svg><path d="M0 0"/></svg></p>`, "svg-hidden"],
    ["role=img with no name", `<span role="img"></span>`, "image-name"],
    ["an img with no alt", `<img src="x.png">`, "image-name"],
    ["a radio outside a radiogroup", `<button role="radio" aria-checked="true">A</button>`, "role-parent"],
    ["a tab outside a tablist", `<button role="tab">A</button>`, "role-parent"],
    ["a radio with no state", `<div role="radiogroup" aria-label="m"><button role="radio">A</button></div>`, "role-state"],
    ["a focusable control inside aria-hidden", `<div aria-hidden="true"><button>Go</button></div>`, "hidden-focusable"],
    ["a positive tabindex", `<button tabindex="3">Go</button>`, "tabindex"],
    ["a button in a button", `<a href="#y">x <button>Go</button></a>`, "nested-interactive"],
    ["a data table with no headers", `<table><tr><td>1</td></tr></table>`, "table-headers"],
    ["two live regions saying the same", `<div role="status">Done</div><div aria-live="polite">Done</div>`, "live-duplicate"],
    ["a live region in a live region", `<div role="status">a <span aria-live="polite">b</span></div>`, "live-nested"],
  ])("catches %s", (_what, html, rule) => {
    expect(problemsOf(html)).toContain(rule);
  });

  it("lets aria-controls name a collapsed panel that is not rendered", () => {
    expect(problemsOf(`<button aria-expanded="false" aria-controls="later-1">More</button>`)).toEqual([]);
  });

  it("reads names the way a screen reader does", () => {
    const host = document.createElement("div");
    host.innerHTML = `<span id="a">First</span><button id="b" aria-labelledby="a">x</button><button id="c" title="Tip"><svg aria-hidden="true"></svg></button><button id="d">Run <span aria-hidden="true">⌘R</span></button><input id="e" placeholder="Search"><label>Rate <input id="f"></label>`;
    document.body.appendChild(host);
    const name = (id: string) => accessibleName(host.querySelector(`#${id}`)!);
    expect([name("b"), name("c"), name("d"), name("e"), name("f")]).toEqual(["First", "Tip", "Run", "Search", "Rate"]);
    expect(roleOf(host.querySelector("#e")!)).toBe("textbox");
    host.remove();
  });

  it("asks for a language on the page", () => {
    const had = document.documentElement.getAttribute("lang");
    document.documentElement.removeAttribute("lang");
    expect(checkA11y(document.body).map((p) => p.rule)).toContain("lang");
    document.documentElement.setAttribute("lang", "en");
    expect(checkA11y(document.body).map((p) => p.rule)).not.toContain("lang");
    if (had === null) document.documentElement.removeAttribute("lang");
  });

  it("the app's two pages declare English", async () => {
    const pages = import.meta.glob("../../*.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(2);
    for (const [file, text] of Object.entries(pages)) expect(text, file).toMatch(/<html lang="en">/);
  });
});

// ── The sweep ────────────────────────────────────────────────────────────────────────────────

/** Every problem in the main document and in each panel window's (the iframes that stand in for them). */
function sweep(frames: HTMLIFrameElement[]): string {
  const docs = [document, ...frames.map((f) => f.contentDocument).filter((d): d is Document => !!d)];
  // jsdom's page has no <html lang>; index.html and mock.html do (checked above).
  return docs.map((d) => formatProblems(checkA11y(d.body, { skip: ["lang"] }))).filter(Boolean).join("\n");
}

describe("every major view", () => {
  const frames: HTMLIFrameElement[] = [];
  const clean = (what: string) => expect(sweep(frames), what).toBe("");

  beforeEach(async () => {
    mockTauri(defaultHandlers());
    mockRuns.replayMs = 5;
    resetSequence();
    resetAdvice();
    resetStructures();
    resetTour();
    resetReports();
    await loadKv();
  });
  /** From here on a panel window is an iframe, so its document can be checked too. */
  const panelsAsFrames = () =>
    vi.spyOn(window, "open").mockImplementation(() => {
      const frame = document.createElement("iframe");
      frame.title = "panel";
      document.body.appendChild(frame);
      frames.push(frame);
      return frame.contentWindow!;
    });
  afterEach(async () => {
    closeFitPanel();
    resetTour();
    await new Promise((r) => setTimeout(r, 10));
    frames.splice(0).forEach((f) => f.remove());
    vi.restoreAllMocks();
  });

  // The Results pane opens docked, or (when the layout says so) in a window of its own: wherever it is.
  const allDocs = () => [document, ...frames.map((f) => f.contentDocument).filter((d): d is Document => !!d)];
  const resultsPane = () => allDocs().map((d) => d.querySelector<HTMLElement>('[data-pane="results"]')).find(Boolean)!;
  const chooseView = async (name: string) => {
    const radio = within(resultsPane().querySelector<HTMLElement>(".pane-header")!).getByRole("radio", { name });
    fireEvent.click(radio);
    await settle(250);
    expect(radio).toHaveAttribute("aria-checked", "true");
  };

  async function solvedTandem() {
    render(<App />);
    await settle(30);
    await act(async () => void (await startTandem()));
    await settle(30);
    expect(await act(() => runCommand("run:solve"))).toBe(true);
    await waitFor(() => expect(resultsPane()).toBeTruthy(), WAIT);
    await chooseView("Table");
    await waitFor(() => expect(resultsPane().querySelector(".results-run")).not.toBeNull(), WAIT);
    await settle(200);
  }

  it("the window at launch: Welcome over an empty workspace", async () => {
    render(<App />);
    const welcome = await screen.findByRole("region", { name: "Welcome to Qnet" }, WAIT);
    await waitFor(() => expect(within(welcome).getAllByRole("listitem").length).toBeGreaterThan(10), WAIT);
    clean("welcome");
    // One h1 on the page, and the sections under it are headed.
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Welcome to Qnet"]);
    expect(within(welcome).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Start", "Recent", "Examples"]);
    // What it covers is out of reach of the keyboard and of a screen reader.
    expect(document.querySelector(".pane-layout")).toHaveAttribute("inert");
  }, 60000);

  it("a network on the canvas: nodes, live results, problems, the inspector, the outline", async () => {
    render(<App />);
    await settle(30);
    await act(async () => void (await startTandem()));
    await settle(400);
    clean("canvas");
    // Every pane is a named landmark (the Status and Results panes were unnamed <div>s).
    const panes = [...document.querySelectorAll<HTMLElement>("[data-pane]")].filter((p) => !p.closest("[hidden]"));
    expect(panes.length).toBeGreaterThanOrEqual(4);
    for (const pane of panes) {
      expect(pane.tagName === "SECTION" || pane.getAttribute("role") === "region", pane.dataset.pane).toBe(true);
      expect(accessibleName(pane), pane.dataset.pane).toBeTruthy();
    }
    const canvas = screen.getByRole("application", { name: "Network canvas" });
    const nodes = [...canvas.querySelectorAll("[data-node]")];
    expect(nodes.length).toBe(6);
    for (const n of nodes) expect(n.getAttribute("aria-label")).toMatch(/^(Source|Buffer|Station|Sink) \S+/);
    // Select a station: the inspector fills in.
    const editor = activeEditor();
    const station = editor.nodes.find((n) => n.kind === "station")!;
    act(() => editor.setNodeSelection(new Set([station.id])));
    await settle(100);
    clean("inspector with a station");
    // A broken network: the badges and the Problems list.
    act(() => setDiagnosticsForTest(editor.tabId, [
      { severity: "error", code: "unstable", nodeIds: [station.id], linkIds: [], values: { name: station.name, rho: 1.2 } },
      { severity: "warning", code: "nearlyUnstable", nodeIds: [station.id], linkIds: [], values: { name: station.name, rho: 0.97 } },
      { severity: "error", code: "noSink", nodeIds: [], linkIds: [], values: {} },
    ]));
    await waitFor(() => expect(document.querySelector(".canvas-problem-badge")).not.toBeNull(), WAIT);
    clean("problem badges");
    fireEvent.click(document.querySelector<HTMLElement>(".canvas-problem-badge")!);
    await settle(50);
    clean("a problem's popover");
    await act(() => runCommand("view:problems-list"));
    expect(await screen.findByRole("dialog", { name: "Problems" })).toBeInTheDocument();
    clean("the Problems list");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Problems" }), { key: "Escape" });
    await act(() => runCommand("view:canvas-outline"));
    expect(await screen.findByRole("dialog", { name: "Canvas Outline" })).toBeInTheDocument();
    clean("the Canvas Outline");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Canvas Outline" }), { key: "Escape" });
  }, 60000);

  it("the Results pane in each of its eight views, with the results on the canvas", async () => {
    await solvedTandem();
    clean("after Solve");
    const seen: string[] = [];
    for (const name of ["Table", "Agreement", "Charts", "Sweep", "Sensitivity", "Capacity", "Uncertainty", "Transient"]) {
      await chooseView(name);
      // The views that compute on arrival (the mock answers in a few ms).
      await settle(400);
      clean(`Results: ${name}`);
      seen.push(name);
      // Every chart in the view has its caption and its table.
      for (const svg of resultsPane().querySelectorAll<SVGElement>("svg[data-chart]")) {
        expect(svg.getAttribute("role"), name).toBe("img");
        expect(svg.getAttribute("aria-label"), name).toBeTruthy();
        const [caption, table] = svg.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id));
        expect(caption?.textContent, name).toBeTruthy();
        expect(table?.querySelectorAll("tbody tr").length, name).toBeGreaterThan(0);
        expect(table?.querySelector("caption")?.textContent, name).toBeTruthy();
      }
    }
    expect(seen.length).toBe(8);
    // The pane has one h2, its own name.
    expect(within(resultsPane()).getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Results");
    // Charts did draw.
    await chooseView("Charts");
    expect(resultsPane().querySelector("svg[data-chart]")).not.toBeNull();
    await chooseView("Sensitivity");
    expect(resultsPane().querySelector("svg[data-chart], table")).not.toBeNull();
  }, 120000);

  it("the command palette, the tour, animation, a toast and the update sheet", async () => {
    await solvedTandem();
    await act(() => runCommand("view:command-palette"));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    clean("command palette");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull(), WAIT);

    await act(() => runCommand("view:animate"));
    await settle(300);
    clean("animation mode");
    await act(() => runCommand("view:animate"));
    await settle(50);

    let id = "";
    act(() => void (id = toast({ kind: "error", title: "Could not save", body: "The disk is full." })));
    await settle(60);
    clean("a toast");
    // Said once, by the announcer; the card is not a second live region.
    expect(document.querySelector(".toast")).toHaveAttribute("role", "group");
    expect(document.querySelector('[data-announce="assertive"]')).toHaveTextContent("Could not save. The disk is full.");
    act(() => dismissToast(id));

    await act(() => runCommand("app:check-updates"));
    await waitFor(() => expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull(), WAIT);
    clean("the update sheet");
    const sheet = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await settle(50);

    await act(() => runCommand("tour:start"));
    await waitFor(() => expect(document.querySelector(".tour-callout")).not.toBeNull(), WAIT);
    clean("the tour");
    expect(screen.getByRole("region", { name: /tour/i })).toHaveFocus();
  }, 120000);

  it("the assistant with an explanation, scenarios, and the panels in their own windows", async () => {
    installExplainModel();
    await solvedTandem();
    await chooseView("Agreement");
    fireEvent.click(within(resultsPane()).getAllByRole("button", { name: /Explain/ })[0]);
    await settle(800);
    clean("the assistant after Explain");

    const tab = activeTab().id;
    act(() => void createScenario(tab, "Faster S1"));
    await settle(100);
    clean("a scenario shown");
    fireEvent.click(screen.getByRole("button", { name: /^Scenario:/ }));
    await settle(50);
    clean("the scenario switcher's menu");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    panelsAsFrames();
    act(() => openCompare(tab));
    await waitFor(() => expect(frames.some((f) => f.contentDocument?.querySelector("table"))).toBe(true), WAIT);
    clean("Compare Scenarios");

    act(() => openFitPanel({ kind: "station", target: "the service time at S1", apply: () => {} }));
    await waitFor(() => expect(frames.some((f) => f.contentDocument?.querySelector("textarea"))).toBe(true), WAIT);
    clean("Fit from Data");

    const r = sampleReport({});
    mockReports.reports[r.id] = r;
    render(<FailureReportHost />);
    act(() => openReport(r.id, tab));
    await waitFor(() => expect(frames.some((f) => f.contentDocument?.querySelector(".report-problem, h2, h1"))).toBe(true), WAIT);
    await settle(200);
    clean("a failure report");
  }, 120000);
});
