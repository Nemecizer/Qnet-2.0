// The canvas without a pointer (new in 2.1, ledger WF-602…608): what the canvas says when the
// keyboard moves the selection, Tab that leaves at the ends, Return as the click of a drawing
// tool, and the Canvas Outline — the network as two tables with every edit as a button.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { activeEditor, type Editor } from "../../editor";
import { getCommand, registerCommands, runCommand } from "../../lib/commands";
import { specItem } from "../../lib/menuSpec";
import { checkA11y, formatProblems } from "../../test/a11y/check";
import { CanvasView } from "../CanvasView";
import { keyboardSpot, KEYBOARD_PITCH } from "../interaction/controller";
import { setDiagnosticsForTest } from "../validation/store";
import { OUTLINE_COMMAND, outlineCommands } from "./commands";
import { linkFacts, nodeFacts, selectionSpoken } from "./describe";
import { outlineOpen, setOutlineOpen } from "./store";
import { outlineWords as w } from "./words";

class FixedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, contentRect: { width: 1200, height: 800, x: 0, y: 0 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
  document.querySelectorAll("[data-announce]").forEach((el) => (el.textContent = ""));
});
afterEach(() => vi.unstubAllGlobals());

const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const spoken = () => document.querySelector<HTMLElement>('[data-announce="polite"]')?.textContent ?? "";

/** Src1 → B1 → S1 → Sink1 on one row, as the pointer would have drawn it. */
function line(editor: Editor) {
  const src = editor.addNode("source", { x: 112, y: 112 });
  const buf = editor.addNode("buffer", { x: 224, y: 112 });
  const st = editor.addNode("station", { x: 336, y: 112 });
  const sink = editor.addNode("sink", { x: 448, y: 112 });
  editor.addLink(src.id, buf.id);
  editor.addLink(buf.id, st.id);
  editor.addLink(st.id, sink.id);
  editor.deselectAll();
  return { src, buf, st, sink };
}

async function mount() {
  const editor = activeEditor();
  let made!: ReturnType<typeof line>;
  act(() => void (made = line(editor)));
  const off = registerCommands(outlineCommands());
  render(<CanvasView editor={editor} />);
  await settle();
  return { editor, ...made, off, surface: screen.getByRole("application", { name: "Network canvas" }) };
}

describe("the canvas with the keyboard", () => {
  it("tells a screen reader how it is driven, and where the outline is", async () => {
    const { surface, off } = await mount();
    expect(surface.getAttribute("aria-description")).toContain("Tab and Shift Tab walk the nodes");
    expect(surface.getAttribute("aria-description")).toContain("Canvas Outline");
    off();
  });

  it("reads the node out when Tab selects it, with its parameters and its problems (WF-603)", async () => {
    const { editor, st, surface, off } = await mount();
    act(() => setDiagnosticsForTest(editor.tabId, [{ severity: "error", code: "unstable", nodeIds: [st.id], linkIds: [], values: { name: "S1", rho: 1.2 } }]));
    surface.focus();
    fireEvent.keyDown(surface, { key: "Tab" });
    await waitFor(() => expect(spoken()).toBe("Selected: Source Src1, Poisson, arrival rate λ = 1 jobs per time unit, SCV 1 (exponential)"), { timeout: 5000 });
    fireEvent.keyDown(surface, { key: "Tab" });
    fireEvent.keyDown(surface, { key: "Tab" });
    await waitFor(() => expect(spoken()).toMatch(/^Selected: Station S1, .*service rate μ = .*\. 1 problem: Error\. Work arrives at S1 faster than it can be served/), { timeout: 5000 });
    fireEvent.keyDown(surface, { key: "Escape" });
    await waitFor(() => expect(spoken()).toBe(w.spokenNone), { timeout: 5000 });
    off();
  });

  it("says nothing when the selection changes while the keyboard is somewhere else", async () => {
    const { editor, st, off } = await mount();
    act(() => editor.setNodeSelection(new Set([st.id])));
    await settle(80);
    expect(spoken()).toBe("");
    off();
  });

  it("lets Tab leave at the last node and Shift-Tab at the first: the canvas is not a keyboard trap (WF-602)", async () => {
    const { editor, src, sink, surface, off } = await mount();
    surface.focus();
    const press = (shiftKey = false) => !fireEvent.keyDown(surface, { key: "Tab", shiftKey });
    expect(press()).toBe(true); // used: Src1
    expect(editor.view.selectedNodeID).toBe(src.id);
    expect(press(true)).toBe(false); // at the first: the key is the browser's
    expect(editor.view.selectedNodeID).toBe(src.id);
    for (let i = 0; i < 3; i++) expect(press()).toBe(true);
    expect(editor.view.selectedNodeID).toBe(sink.id);
    expect(press()).toBe(false);
    expect(editor.view.selectedNodeID).toBe(sink.id);
    off();
  });

  it("Return is the Link tool's click: start at the selected node, then the next one (WF-605)", async () => {
    const { editor, st, surface, off } = await mount();
    let extra!: ReturnType<Editor["addNode"]>;
    act(() => void (extra = editor.addNode("sink", { x: 448, y: 224 })));
    const before = editor.links.length;
    surface.focus();
    fireEvent.keyDown(surface, { key: "l" });
    expect(editor.view.tool).toBe("addLink");
    act(() => editor.setNodeSelection(new Set([st.id])));
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(editor.view.pendingLinkStartID).toBe(st.id);
    expect(editor.view.parameterEditorTarget).toBeNull();
    act(() => editor.setNodeSelection(new Set([extra.id])));
    fireEvent.keyDown(surface, { key: "Enter" });
    await settle();
    expect(editor.links.length).toBe(before + 1);
    expect(editor.links[editor.links.length - 1]).toMatchObject({ fromNodeID: st.id, toNodeID: extra.id });
    off();
  });

  it("Return with a node tool places the node one pitch to the right of the selection, on a free spot (WF-605)", async () => {
    const { editor, st, sink, surface, off } = await mount();
    surface.focus();
    act(() => editor.setNodeSelection(new Set([st.id])));
    // Beside S1 is where Sink1 already is: the spot steps on to the right.
    expect(keyboardSpot(editor, st.id)).toEqual({ x: sink.position[0] + KEYBOARD_PITCH, y: sink.position[1] });
    fireEvent.keyDown(surface, { key: "s" });
    fireEvent.keyDown(surface, { key: "Enter" });
    await settle();
    const made = editor.nodes[editor.nodes.length - 1];
    expect(made).toMatchObject({ kind: "station", position: [sink.position[0] + KEYBOARD_PITCH, 112] });
    expect(editor.view.selectedNodeID).toBe(made.id);
    // With the Pointer, Return is still Edit Parameters.
    fireEvent.keyDown(surface, { key: "v" });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(editor.view.parameterEditorTarget).toBe(made.id);
    off();
  });
});

describe("a node and a link as text", () => {
  it("carry the parameters, the problems and the link's route", async () => {
    const { editor, st, off } = await mount();
    const diagnostics = [{ severity: "warning" as const, code: "nearlyUnstable", nodeIds: [st.id], linkIds: [], values: { name: "S1", rho: 0.97 } }];
    const ctx = { editor, results: null, diagnostics };
    const f = nodeFacts(ctx, st);
    expect([f.kind, f.result, f.problems.length]).toEqual(["Station", null, 1]);
    expect(f.parameters).toContain("service rate μ =");
    expect(f.spoken).toContain("1 problem: Warning. S1 is busy almost all the time");
    const l = linkFacts(ctx, editor.links[0]);
    expect([l.label, l.cls, l.probability]).toEqual(["Src1 → B1", "Class 1", "1"]);
    expect(l.spoken).toBe("Link, Src1 to B1");
    act(() => editor.setNodeSelection(new Set(editor.nodes.slice(0, 2).map((n) => n.id))));
    expect(selectionSpoken(ctx)).toBe("2 nodes selected.");
    off();
  });
});

describe("the Canvas Outline", () => {
  const openOutline = async () => {
    await act(() => runCommand(OUTLINE_COMMAND));
    return screen.findByRole("dialog", { name: w.title });
  };

  it("is a View-menu command with a key of its own (WF-604)", () => {
    expect(specItem(OUTLINE_COMMAND)).toMatchObject({ label: "Canvas Outline", accel: "CmdOrCtrl+Alt+O", check: true });
    const off = registerCommands(outlineCommands());
    expect(getCommand(OUTLINE_COMMAND)).toBeDefined();
    off();
  });

  it("lists every node and link with headers, takes the keyboard, and passes the checker (WF-604)", async () => {
    const { off } = await mount();
    const dialog = await openOutline();
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText("4 nodes, 3 links")).toBeInTheDocument();
    const nodes = within(dialog).getByRole("table", { name: w.nodesHeading });
    expect(within(nodes).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Node", "Kind", "Parameters", "Result", "Problems"]);
    expect(within(nodes).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Src1", "B1", "S1", "Sink1"]);
    const links = within(dialog).getByRole("table", { name: w.linksHeading });
    expect(within(links).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Src1 → B1", "B1 → S1", "S1 → Sink1"]);
    expect(formatProblems(checkA11y(document.body, { skip: ["lang"] }))).toBe("");
    off();
  });

  it("selects a row on the canvas, with arrow keys between the rows of a table (WF-606)", async () => {
    const { editor, st, off } = await mount();
    const dialog = await openOutline();
    const rows = within(within(dialog).getByRole("table", { name: w.nodesHeading })).getAllByRole("button");
    // One Tab stop for the table.
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(rows[3]).toHaveFocus();
    fireEvent.keyDown(rows[3], { key: "ArrowUp" });
    fireEvent.click(rows[2]);
    expect(editor.view.selectedNodeID).toBe(st.id);
    expect(rows[2]).toHaveAttribute("aria-pressed", "true");
    expect(rows[2].getAttribute("aria-label")).toMatch(/^Select Station S1, /);
    expect(within(dialog).getByText("Station S1")).toBeInTheDocument();
    // The canvas shows the same selection.
    expect(document.querySelector(`[data-node="${st.id}"]`)).toHaveAttribute("aria-pressed", "true");
    off();
  });

  it("adds, links, moves and deletes without a pointer, each an undoable step (WF-607)", async () => {
    const { editor, st, off } = await mount();
    const dialog = await openOutline();
    const row = (name: string) => within(dialog).getByRole("button", { name: new RegExp(`^Select [A-Za-z]+ ${name}\\b`) });
    fireEvent.click(row("S1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Sink" }));
    await settle(60);
    const added = editor.nodes[editor.nodes.length - 1];
    expect(added.kind).toBe("sink");
    expect(spoken()).toBe(`Added sink ${added.name}.`);
    // Link S1 to the new sink through the Link tool's own rules.
    fireEvent.click(row("S1"));
    const before = editor.links.length;
    const linkButton = within(dialog).getByRole("button", { name: w.addLink });
    expect(linkButton).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("combobox", { name: w.linkTo }), { target: { value: added.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: w.addLink }));
    await settle(60);
    expect(editor.links.length).toBe(before + 1);
    expect(editor.links[editor.links.length - 1]).toMatchObject({ fromNodeID: st.id, toNodeID: added.id });
    expect(editor.view.tool).toBe("select");
    expect(editor.view.pendingLinkStartID).toBeNull();
    // Move S1 one step right.
    fireEvent.click(row("S1"));
    const x = editor.node(st.id)!.position[0];
    fireEvent.click(within(dialog).getByRole("button", { name: w.move.right }));
    await settle(60);
    expect(editor.node(st.id)!.position[0]).toBe(x + editor.nudgeStep(false));
    expect(spoken()).toMatch(/^S1 moved to /);
    // Delete the sink that was added, and bring it back.
    fireEvent.click(row(added.name));
    fireEvent.click(within(dialog).getByRole("button", { name: w.remove }));
    await settle();
    expect(editor.node(added.id)).toBeUndefined();
    act(() => editor.undo());
    expect(editor.node(added.id)).toBeDefined();
    off();
  });

  it("shows a node's problems with their fixes, and counts them in its row", async () => {
    const { editor, st, off } = await mount();
    act(() => setDiagnosticsForTest(editor.tabId, [{ severity: "error", code: "unstable", nodeIds: [st.id], linkIds: [], values: { name: "S1", rho: 1.2 } }]));
    const dialog = await openOutline();
    const nodes = within(dialog).getByRole("table", { name: w.nodesHeading });
    expect(within(nodes).getByText("1 error")).toBeInTheDocument();
    fireEvent.click(within(nodes).getByRole("button", { name: /^Select Station S1/ }));
    const problems = within(dialog).getByRole("group", { name: w.problemsOf });
    expect(problems).toHaveTextContent("Error. Work arrives at S1 faster than it can be served");
    off();
  });

  it("keeps Tab inside, and Escape closes it and gives the keyboard back to the canvas", async () => {
    const { surface, off } = await mount();
    const dialog = await openOutline();
    const stops = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), select')];
    stops[stops.length - 1].focus();
    fireEvent.keyDown(stops[stops.length - 1], { key: "Tab" });
    expect(stops[0]).toHaveFocus();
    fireEvent.keyDown(stops[0], { key: "Tab", shiftKey: true });
    expect(stops[stops.length - 1]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: w.title })).toBeNull();
    expect(outlineOpen()).toBe(false);
    expect(surface).toHaveFocus();
    act(() => setOutlineOpen(false));
    off();
  });
});
