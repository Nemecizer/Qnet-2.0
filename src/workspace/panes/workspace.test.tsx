// The pane layout against the simulated backend: the panes it draws, the commands of View ▸ Panes
// and Window ▸ Focus, the routed Find and text-size items, the top bar, detached windows and the
// dividers (persisted through the kv stores).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers, type MockOptions } from "../../dev/mockBackend";
import { getCommand, runCommand, titleOf, unavailableReason } from "../../lib/commands";
import { getSetting, getStateValue, loadKv } from "../../lib/kv";
import { mockTauri } from "../../test/tauri";
import { registerFocusTarget } from "../focus";
import { resetLive } from "../layout/live";
import { usePaneCommands, Workspace, WorkspaceToolbar } from "../Workspace";
import { resetFocusState } from "./focusState";
import { resetHosts } from "./hosts";
import { isShellAlias } from "./commands";

function Harness() {
  usePaneCommands();
  return (
    <>
      <WorkspaceToolbar />
      <Workspace />
    </>
  );
}

async function setup(opts: MockOptions = {}) {
  mockTauri(defaultHandlers(opts));
  const r = render(<Harness />);
  await act(async () => {
    await loadKv();
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}

const pane = (id: string, doc: Document = document) => doc.querySelector<HTMLElement>(`[data-pane="${id}"]`);
const run = (id: string) => act(async () => {
  await runCommand(id);
});
const cmd = (id: string) => getCommand(id)!;

/** window.open → an iframe's window, so an AuxWindow really renders somewhere in jsdom. */
function stubWindows() {
  const opened: { name: string; win: Window; frame: HTMLIFrameElement }[] = [];
  vi.spyOn(window, "open").mockImplementation((_url, target) => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    opened.push({ name: String(target), win, frame });
    return win;
  });
  return opened;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetHosts();
  resetLive();
  resetFocusState();
  document.querySelectorAll("iframe").forEach((f) => f.remove());
});

describe("the main window's panes (WS-050, WS-051, WS-053)", () => {
  it("draws Tools, the canvas, Inspector over Status and the Shell, and leaves Results and AI hidden", async () => {
    await setup();
    for (const p of ["tools", "canvas", "inspector", "status", "shell"]) expect(pane(p)).not.toBeNull();
    expect(pane("results")).toBeNull();
    expect(pane("ai")).toBeNull();
    const splits = [...document.querySelectorAll("[data-split]")].map((e) => e.getAttribute("data-split"));
    expect(splits).toEqual(["OuterVSplit", "TopHSplit", "RightVSplit", "BottomHSplit"]);
    expect([...document.querySelectorAll('[data-split="RightVSplit"] > .split-item')].map((e) => e.getAttribute("data-split-pane"))).toEqual(["inspector", "status"]);
  });

  it("toggles a pane from View ▸ Panes, with its check mark, tooltip and setting (MENU-066…071, WS-052)", async () => {
    await setup();
    expect(cmd("view:pane-results").checked!()).toBe(false);
    expect(cmd("view:pane-results").subtitle).toBe("Show the Results pane");
    await run("view:pane-results");
    expect(getSetting("results.paneVisible", false)).toBe(true);
    expect(pane("results")).not.toBeNull();
    expect(cmd("view:pane-results").subtitle).toBe("Hide the Results pane");
    await run("view:pane-shell");
    expect(pane("shell")).toBeNull();
    expect(document.querySelector('[data-split="BottomHSplit"]')).toBeNull();
  });

  it("keeps the Shell's tree, and every pane's, across hiding, maximizing and rearranging (WS-056, INV-018)", async () => {
    await setup();
    const shell = pane("shell")!;
    await run("view:pane-shell");
    await run("view:pane-shell");
    expect(pane("shell")).toBe(shell);
    const status = pane("status")!;
    await run("view:pane-inspector");
    await run("view:maximize-pane");
    expect(status.isConnected).toBe(false);
    await run("view:maximize-pane");
    await run("view:show-all-panes");
    expect(pane("status")).toBe(status);
    expect(pane("shell")).toBe(shell);
  });
});

describe("maximize (WS-080…085, MENU-081)", () => {
  it("gives the focused pane the whole window and restores it exactly", async () => {
    await setup();
    act(() => pane("status")!.focus());
    expect(titleOf(cmd("view:maximize-pane"))).toBe("Maximize Pane");
    expect(cmd("view:maximize-pane").subtitle).toBe("Give the Status pane the whole window; nothing is hidden and every divider comes back where it is now");
    await run("view:maximize-pane");
    expect(getSetting("panes.soloed", "")).toBe("status");
    expect(pane("canvas")?.isConnected).toBeFalsy();
    expect(pane("shell")?.isConnected).toBeFalsy();
    expect(pane("status")).not.toBeNull();
    expect(titleOf(cmd("view:maximize-pane"))).toBe("Restore Pane Layout");
    expect(cmd("view:maximize-pane").subtitle).toBe("Put every pane back exactly where it was before the Status pane was maximized");
    await run("view:maximize-pane");
    expect(getSetting("panes.soloed", "")).toBe("");
    expect(pane("canvas")).not.toBeNull();
  });

  it("maximizes the canvas when nothing has focus, and a pane toggle ends the maximize (MENU-072)", async () => {
    await setup();
    await run("view:maximize-pane");
    expect(getSetting("panes.soloed", "")).toBe("canvas");
    expect(pane("tools")).toBeNull();
    await run("view:pane-ai");
    expect(getSetting("panes.soloed", "")).toBe("");
    expect(pane("tools")).not.toBeNull();
  });

  it("puts the window control at the end of each header and of the canvas status bar (WS-061, CAN-164)", async () => {
    await setup();
    const btn = within(pane("status")!).getByRole("button", { name: "Maximize Status Pane" });
    expect(btn).toHaveAttribute("title", "Give the Status pane the whole window; the other panes come back exactly as they are now (View ▸ Panes ▸ Maximize Pane, ⌃⌘↩)");
    expect(within(pane("tools")!).queryByRole("button", { name: /Maximize/ })).toBeNull();
    const canvasBtn = within(document.querySelector(".canvas-statusbar")!).getByRole("button", { name: "Maximize Canvas Pane" });
    await act(async () => fireEvent.click(canvasBtn));
    await waitFor(() => expect(getSetting("panes.soloed", "")).toBe("canvas"));
    const restore = within(document.querySelector(".canvas-statusbar")!).getByRole("button", { name: "Restore Pane Layout" });
    expect(restore).toHaveAttribute("title", "Put the other panes back exactly where they were (View ▸ Panes ▸ Restore Pane Layout, ⌃⌘↩)");
  });

  it("remembers a maximize across launches unless the pane is off or detached (WS-084)", async () => {
    await setup({ settings: { "panes.soloed": "inspector" } });
    expect(pane("canvas")?.isConnected).toBeFalsy();
    expect(pane("inspector")).not.toBeNull();
  });

  it("is disabled while a sheet is up", async () => {
    await setup();
    const { holdModal } = await import("../../lib/overlays");
    const release = holdModal();
    expect(unavailableReason(cmd("view:maximize-pane"))).toBe("Close the open dialog first");
    expect(unavailableReason(cmd("window:focus-status"))).toBe("Close the open dialog first");
    release();
  });
});

describe("presets and Show All Panes (WS-060, WS-073…079)", () => {
  it("applies each preset's panes, with their tooltips", async () => {
    await setup({ settings: { "panes.soloed": "status", "panes.detached": "ai" } });
    expect(cmd("view:preset-shell").subtitle).toBe("Make the interactive shell the second half of the window — it takes 45 % of the window's height, with the network above and the status log for context");
    expect(cmd("view:preset-analyze").subtitle).toBe("Give the structured Results workspace 50 % of the window, with the inspector and status log for context");
    await run("view:preset-run");
    expect(getSetting("panes.soloed", "x")).toBe("");
    expect(getSetting("panes.detached", "x")).toBe("");
    expect(["status", "results", "shell"].every((p) => pane(p))).toBe(true);
    expect(pane("tools")).toBeNull();
    await run("view:preset-canvas");
    expect(pane("status")).toBeNull();
    expect(pane("canvas")).not.toBeNull();
  });

  it("writes the Shell preset's row as 45 % of the window", async () => {
    await setup();
    const outer = document.querySelector<HTMLElement>('[data-split="OuterVSplit"]')!;
    vi.spyOn(outer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1500, 800));
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    await run("view:preset-shell");
    expect(getStateValue("SplitPane.OuterVSplit.bottom", 0)).toBe(405);
  });

  it("dims Show All Panes when every pane is home", async () => {
    await setup();
    expect(unavailableReason(cmd("view:show-all-panes"))).toBeNull();
    await run("view:show-all-panes");
    expect(unavailableReason(cmd("view:show-all-panes"))).toBe("Every pane is already showing in this window");
    expect(["tools", "status", "shell", "ai", "inspector", "results"].every((p) => pane(p))).toBe(true);
  });
});

describe("detached panes (WS-086…098, SH-013)", () => {
  it("moves a pane into its own window, titled “<network> — <pane>”, and back when the window closes", async () => {
    const opened = stubWindows();
    await setup();
    const shell = pane("shell")!;
    await run("view:detach-shell");
    expect(getSetting("panes.detached", "")).toBe("shell");
    expect(opened.map((o) => o.name)).toEqual(["qnet-pane-shell"]);
    const doc = opened[0].win.document;
    expect(doc.title).toBe("Untitled — Shell");
    // The title follows tab switches and renames (WS-090).
    const { addTab } = await import("../store");
    act(() => void addTab({ title: "tandem" }));
    expect(doc.title).toBe("tandem — Shell");
    expect(pane("shell", doc)).toBe(shell); // the same tree, moved: not rebuilt
    expect(document.querySelector('[data-split="BottomHSplit"]')).toBeNull();
    expect(cmd("view:detach-shell").checked!()).toBe(true);
    expect(within(pane("shell", doc)!).getByRole("button", { name: "Return Shell to the Main Window" }).getAttribute("title")).toBe(
      "Put the Shell pane back into the main window, where it was before (closing this window does the same)",
    );
    // Escape does not close it (WS-091).
    act(() => void opened[0].win.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(getSetting("panes.detached", "")).toBe("shell");
    // The user closes the window.
    await act(async () => {
      opened[0].win.dispatchEvent(new Event("pagehide"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(getSetting("panes.detached", "x")).toBe(""));
    expect(pane("shell")).toBe(shell);
  });

  it("switches a hidden pane on as it detaches, and hiding it keeps it detached (WS-088, WS-094)", async () => {
    const opened = stubWindows();
    await setup();
    await run("view:detach-ai");
    expect(getSetting("ai.paneVisible", false)).toBe(true);
    expect(opened).toHaveLength(1);
    await run("view:pane-ai");
    expect(getSetting("panes.detached", "")).toBe("ai");
    expect(pane("ai")).toBeNull();
    expect(unavailableReason(cmd("view:reattach-all"))).toBeNull();
    await run("view:reattach-all");
    expect(unavailableReason(cmd("view:reattach-all"))).toBe("Every pane is already in the main window");
  });

  it("reopens remembered windows at launch (WS-096)", async () => {
    const opened = stubWindows();
    await setup({ settings: { "panes.detached": "inspector,status" } });
    expect(opened.map((o) => o.name)).toEqual(["qnet-pane-status", "qnet-pane-inspector"]);
    expect(pane("inspector")).toBeNull();
  });

  it("follows focus inside a detached window and routes Find there (WS-098)", async () => {
    const opened = stubWindows();
    await setup();
    await run("view:detach-results");
    const stop = registerFocusTarget("results", { findTitle: "Filter Results…", find: () => {} });
    const doc = opened[0].win.document;
    vi.spyOn(doc, "hasFocus").mockReturnValue(true);
    act(() => pane("results", doc)!.focus());
    expect(titleOf(cmd("edit:find"))).toBe("Filter Results…");
    stop();
  });
});

describe("Window ▸ Focus (WS-062, MENU-146…153, KEY-001)", () => {
  it("shows a hidden pane, then focuses it once the layout settles", async () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    await setup();
    expect(cmd("window:focus-results").subtitle).toBe("Show the Results workspace if hidden and move keyboard focus to its filter");
    await run("window:focus-results");
    expect(getSetting("results.paneVisible", false)).toBe(true);
    await waitFor(() => expect(pane("results")!.contains(document.activeElement)).toBe(true));
  });

  it("ends another pane's maximize first, and uses the pane's own focus handler", async () => {
    await setup({ settings: { "panes.soloed": "status" } });
    const focus = vi.fn();
    const stop = registerFocusTarget("inspector", { focus });
    await run("window:focus-inspector");
    expect(getSetting("panes.soloed", "x")).toBe("");
    await waitFor(() => expect(focus).toHaveBeenCalled());
    stop();
  });

  it("⌃` focuses the Shell", async () => {
    await setup();
    expect(isShellAlias({ code: "Backquote", key: "`", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isShellAlias({ code: "Backquote", key: "`", ctrlKey: true, metaKey: true, altKey: false, shiftKey: false })).toBe(false);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true })));
    await waitFor(() => expect(pane("shell")!.contains(document.activeElement)).toBe(true));
  });

  it("lights the focused pane's header rule, and the canvas's on its tab bar (WS-013)", async () => {
    await setup();
    act(() => pane("status")!.focus());
    expect(pane("status")!.querySelector(".pane-header")).toHaveAttribute("data-focused");
    act(() => (document.querySelector(".canvas-placeholder") as HTMLElement).focus());
    expect(document.querySelector(".canvas-tabbar")).toHaveAttribute("data-focused");
    expect(pane("status")!.querySelector(".pane-header")).not.toHaveAttribute("data-focused");
  });
});

describe("routed Find and pane text size (MENU-047, MENU-052/053, MENU-083/084, WS-014)", () => {
  it("names ⌘F after the focused pane, and after the canvas otherwise", async () => {
    await setup();
    expect(titleOf(cmd("edit:find"))).toBe("Find Node…");
    expect(unavailableReason(cmd("edit:find"))).not.toBeNull();
    const find = vi.fn();
    const step = vi.fn();
    let matches = false;
    const stop = registerFocusTarget("status", { findTitle: "Search Status Log…", find, stepFind: step, canStepFind: () => matches });
    act(() => pane("status")!.focus());
    expect(titleOf(cmd("edit:find"))).toBe("Search Status Log…");
    expect(cmd("edit:find").subtitle).toBe("Move the keyboard focus to the Status pane's search field");
    await run("edit:find");
    expect(find).toHaveBeenCalled();
    expect(unavailableReason(cmd("edit:find-next"))).toBe("Search the Status log first (⌘F); Find Next then steps through the matching entries");
    matches = true;
    expect(cmd("edit:find-next").subtitle).toBe("Select the next entry that matches the Status pane's search");
    await run("edit:find-next");
    await run("edit:find-previous");
    expect(step.mock.calls).toEqual([[1], [-1]]);
    stop();
  });

  it("routes Find to the Settings window's handlers while it has focus", async () => {
    const opened = stubWindows();
    await setup();
    const { AuxWindow } = await import("../../lib/auxWindow");
    const stop = registerFocusTarget("window:settings", { findTitle: "Search Settings…", find: () => {} });
    render(<AuxWindow name="settings" title="Settings" size={[600, 400]} onClose={() => {}}><input /></AuxWindow>);
    vi.spyOn(opened[0].win.document, "hasFocus").mockReturnValue(true);
    expect(titleOf(cmd("edit:find"))).toBe("Search Settings…");
    stop();
  });

  it("changes the focused pane's text size, dimmed with a reason at its limit or on the canvas", async () => {
    await setup();
    expect(unavailableReason(cmd("view:pane-text-bigger"))).toBe(
      "Increase the text size of the focused pane — click in the Status, Shell or AI Assistant pane first (the canvas uses ⌘= / ⌘−)",
    );
    const zoom = vi.fn();
    const stop = registerFocusTarget("shell", { zoom, canZoom: (d) => d < 0 });
    act(() => pane("shell")!.focus());
    expect(unavailableReason(cmd("view:pane-text-bigger"))).toBe("The Shell pane is already at its largest text size");
    expect(cmd("view:pane-text-smaller").subtitle).toBe("Decrease the Shell pane's text size");
    await run("view:pane-text-smaller");
    expect(zoom).toHaveBeenCalledWith(-1);
    stop();
  });
});

describe("the top bar (WS-009…011, TB-005…013)", () => {
  it("has the Workspace menu and six toggles in 0.90.34's order, with their tooltips", async () => {
    await setup();
    const bar = screen.getByRole("toolbar", { name: "Panes" });
    const items = [...bar.querySelectorAll("[data-toolbar-item]")].map((b) => b.getAttribute("data-toolbar-item"));
    // 2.1 puts the primary Solve button first (ledger UX-111), then the scenario switcher (WF-108).
    expect(items).toEqual(["solve", "scenario", "straighten", "fit", "panes.workspace", "panes.palette", "panes.status", "panes.results", "panes.inspector", "panes.shell", "panes.ai"]);
    expect(within(bar).getByRole("button", { name: "Tools pane" })).toHaveAttribute("title", "Show or hide the Tools pane (⌥⌘1)");
    expect(within(bar).getByRole("button", { name: "Results workspace" })).toHaveAttribute("title", "Show or hide the structured Results workspace (⌥⌘6)");
    expect(within(bar).getByRole("button", { name: "Tools pane" })).toHaveAttribute("aria-pressed", "true");
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "AI Assistant pane" })));
    await waitFor(() => expect(getSetting("ai.paneVisible", false)).toBe(true));
  });

  it("opens the Workspace menu with the presets, Maximize and Separate Windows; its glyph and tooltip name a maximized pane", async () => {
    await setup();
    const btn = screen.getByRole("button", { name: "Workspace arrangement" });
    expect(btn).toHaveAttribute("title", "Apply a pane arrangement, or give one pane the whole window (View ▸ Panes)");
    await act(async () => fireEvent.click(btn));
    const menu = screen.getByRole("menu", { name: "Workspace" });
    const labels = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    expect(labels).toEqual(["Build Network", "Analyze Results", "Run and Diagnose", "Shell", "Canvas Only", "Maximize Pane", "Separate Windows"]);
    expect(within(menu).getByRole("menuitem", { name: "Build Network" })).toHaveAttribute("title", "Show the drawing tools, inspector and status log");
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Maximize Pane" })));
    await waitFor(() => expect(getSetting("panes.soloed", "")).toBe("canvas"));
    const max = screen.getByRole("button", { name: "Workspace arrangement, Canvas pane maximized" });
    expect(max).toHaveAttribute("title", "The Canvas pane has the whole window — choose Restore Pane Layout to bring the others back (View ▸ Panes)");
  });
});

describe("dividers (WS-064…067, WS-069)", () => {
  function sizeItems(split: string, sizes: number[], vertical = false) {
    const items = [...document.querySelectorAll(`[data-split="${split}"] > .split-item`)] as HTMLElement[];
    items.forEach((el, i) => vi.spyOn(el, "getBoundingClientRect").mockReturnValue(vertical ? new DOMRect(0, 0, 1500, sizes[i]) : new DOMRect(0, 0, sizes[i], 500)));
    const host = document.querySelector<HTMLElement>(`[data-split="${split}"]`)!;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, sizes.reduce((a, b) => a + b, 0), 500));
  }

  it("saves the dragged pane under SplitPane.<split>.<pane>, and the legacy array with the full set", async () => {
    await setup();
    sizeItems("TopHSplit", [176, 1003, 320]);
    const divider = document.querySelector<HTMLElement>('[data-divider="TopHSplit:0"]')!;
    await act(async () => {
      fireEvent.pointerDown(divider, { button: 0, clientX: 176, pointerId: 1 });
      fireEvent.pointerMove(divider, { clientX: 206, pointerId: 1 });
      fireEvent.pointerUp(divider, { clientX: 206, pointerId: 1 });
    });
    await waitFor(() => expect(getStateValue("SplitPane.TopHSplit.palette", 0)).toBe(206));
    expect(getStateValue("SplitSizes.TopHSplit", null)).toEqual([206, 973, 320]);
    expect(getStateValue("SplitPane.TopHSplit.canvas", null)).toBeNull();
  });

  it("mirrors the right column's width to the AI pane while both rows are full", async () => {
    await setup({ settings: { "ai.paneVisible": true } });
    sizeItems("TopHSplit", [176, 1003, 320]);
    sizeItems("BottomHSplit", [1244, 255]);
    const divider = document.querySelector<HTMLElement>('[data-divider="TopHSplit:1"]')!;
    await act(async () => {
      fireEvent.pointerDown(divider, { button: 0, clientX: 1180, pointerId: 1 });
      fireEvent.pointerMove(divider, { clientX: 1160, pointerId: 1 });
      fireEvent.pointerUp(divider, { clientX: 1160, pointerId: 1 });
    });
    await waitFor(() => expect(getStateValue("SplitPane.TopHSplit.right", 0)).toBe(340));
    expect(getStateValue("SplitPane.BottomHSplit.ai", 0)).toBe(340);
  });

  it("puts corner grips at the T-junctions, with their tooltip and labels (WS-069…071)", async () => {
    await setup({ settings: { "ai.paneVisible": true } });
    const grips = [...document.querySelectorAll("[data-grip]")].map((g) => g.getAttribute("data-grip"));
    expect(grips).toEqual(["top.palette.canvas", "top.canvas.status", "bottom.terminal.ai"]);
    const g = screen.getAllByRole("img", { name: "Pane corner resize handle" })[0];
    expect(g).toHaveAttribute("title", "Drag to resize both panes");
    expect(g).toHaveAttribute("aria-description", "Drag to move the horizontal and vertical dividers together");
    await run("view:pane-tools");
    expect([...document.querySelectorAll("[data-grip]")].map((x) => x.getAttribute("data-grip"))).toEqual(["bottom.terminal.ai"]);
  });

  it("moves both dividers when a corner grip is dragged", async () => {
    await setup();
    sizeItems("TopHSplit", [176, 1003, 320]);
    sizeItems("OuterVSplit", [600, 248], true);
    const grip = document.querySelector<HTMLElement>('[data-grip="top.palette.canvas"]')!;
    await act(async () => {
      fireEvent.pointerDown(grip, { button: 0, clientX: 176, clientY: 600, pointerId: 1 });
      fireEvent.pointerMove(grip, { clientX: 196, clientY: 560, pointerId: 1 });
      fireEvent.pointerUp(grip, { pointerId: 1 });
    });
    await waitFor(() => expect(getStateValue("SplitPane.TopHSplit.palette", 0)).toBe(196));
    expect(getStateValue("SplitPane.OuterVSplit.bottom", 0)).toBe(288);
  });
});
