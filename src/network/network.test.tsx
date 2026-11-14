// The Network menu's canvas commands (ledger MENU-085, 089…100, CAN-210…213): their gating, as
// 0.90.34's `networkMenu` had it, and their effect on the editor, with its undo names and Status
// sentences.
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { defaultHandlers } from "../dev/mockBackend";
import { buildArchetypeDocument } from "../dev/mock/archetypes";
import { getCommand, runCommand, unavailableReason } from "../lib/commands";
import { holdModal } from "../lib/overlays";
import { activeEditor } from "../editor";
import { activeTab, setDocument } from "../workspace/store";
import { mockTauri } from "../test/tauri";
import { DEFAULT_PARAMETERS } from "../windows/archetypes/insert";
import { useNetworkCommands } from ".";

function Harness() {
  useNetworkCommands();
  return null;
}

function setup(withNetwork = true) {
  mockTauri(defaultHandlers());
  render(<Harness />);
  if (withNetwork) {
    let n = 0;
    act(() => setDocument(activeTab().id, buildArchetypeDocument({ kind: "tandemLine", ...DEFAULT_PARAMETERS }, () => `N${++n}`)));
  }
  return activeEditor();
}

const reason = (id: string) => unavailableReason(getCommand(id)!);
const lastLog = () => activeTab().log[activeTab().log.length - 1]?.text;
const run = async (id: string) => {
  await act(async () => {
    await runCommand(id);
    await Promise.resolve();
  });
};

const ARRANGE = ["network:align-left", "network:align-hcentre", "network:align-right", "network:align-top", "network:align-vcentre", "network:align-bottom"];
const DISTRIBUTE = ["network:distribute-h", "network:distribute-v"];

describe("Buffer Model (MENU-085)", () => {
  it("checks the document's regime, changes it as one undoable step, and waits while a sheet is up", async () => {
    const e = setup();
    expect(e.infiniteBuffers).toBe(true);
    expect(getCommand("network:infinite-buffers")!.checked!()).toBe(true);
    expect(getCommand("network:finite-buffers")!.checked!()).toBe(false);
    await run("network:finite-buffers");
    expect(e.infiniteBuffers).toBe(false);
    expect(getCommand("network:finite-buffers")!.checked!()).toBe(true);
    expect(e.undoManager.undoActionName).toBe("Change Buffer Mode");
    act(() => e.undo());
    expect(e.infiniteBuffers).toBe(true);
    const release = holdModal();
    expect(reason("network:finite-buffers")).toBe("Close the open dialog first");
    expect(reason("network:infinite-buffers")).toBe("Close the open dialog first");
    release();
  });
});

describe("Straighten (MENU-089, MENU-090, CAN-212, CAN-213)", () => {
  it("needs a network, and nothing else", () => {
    setup(false);
    expect(reason("network:straighten")).toBe("Draw or open a network first");
    expect(reason("network:straighten-fit")).toBe("Draw or open a network first");
    let n = 0;
    act(() => setDocument(activeTab().id, buildArchetypeDocument({ kind: "mmcStation", ...DEFAULT_PARAMETERS }, () => `M${++n}`)));
    const release = holdModal();
    expect(reason("network:straighten")).toBeNull();
    expect(reason("network:straighten-fit")).toBeNull();
    release();
  });

  it("Straighten Network lays the nodes on one row 88 pt apart, undoable as 'Straighten Network'", async () => {
    const e = setup();
    act(() => e.moveNode(e.nodes[2].id, { x: 300, y: 400 }, false));
    await act(async () => Promise.resolve());
    await run("network:straighten");
    const ys = new Set(e.nodes.map((n) => n.position[1]));
    expect(ys.size).toBe(1);
    const xs = e.nodes.map((n) => n.position[0]).sort((a, b) => a - b);
    expect(xs.slice(1).map((x, i) => x - xs[i])).toEqual(Array(xs.length - 1).fill(88));
    expect(e.undoManager.undoActionName).toBe("Straighten Network");
    expect(lastLog()).toBe("Straightened network layout.");
  });

  it("Straighten and Fit waits for the canvas size, then fits at zoom 1 as 'Straighten and Fit'", async () => {
    const e = setup();
    await run("network:straighten-fit");
    expect(lastLog()).toBe("Canvas size not yet known; try again after the window finishes laying out.");
    act(() => e.setViewportSize({ width: 1000, height: 600 }));
    act(() => e.setView({ canvasScale: 2 }));
    await run("network:straighten-fit");
    expect(lastLog()).toBe("Straightened and fit the network to the window.");
    expect(e.undoManager.undoActionName).toBe("Straighten and Fit");
    expect(e.view.canvasScale).toBe(1);
    const xs = e.nodes.map((n) => n.position[0]);
    expect(Math.min(...xs)).toBeCloseTo(80);
    expect(Math.max(...xs)).toBeCloseTo(920);
  });
});

describe("Arrange (MENU-091…098, CAN-210, CAN-211)", () => {
  it("align needs two nodes in the group selection, distribute three, and both wait under a sheet", () => {
    const e = setup();
    for (const id of [...ARRANGE, ...DISTRIBUTE]) expect(reason(id)).toBe(id.includes("distribute") ? "Select three or more nodes first" : "Select two or more nodes first");
    act(() => e.setNodeSelection(new Set(e.nodes.slice(0, 2).map((n) => n.id))));
    for (const id of ARRANGE) expect(reason(id)).toBeNull();
    for (const id of DISTRIBUTE) expect(reason(id)).toBe("Select three or more nodes first");
    act(() => e.setNodeSelection(new Set(e.nodes.slice(0, 3).map((n) => n.id))));
    for (const id of [...ARRANGE, ...DISTRIBUTE]) expect(reason(id)).toBeNull();
    const release = holdModal();
    for (const id of [...ARRANGE, ...DISTRIBUTE]) expect(reason(id)).toBe("Close the open dialog first");
    release();
  });

  it("each item runs its editor method, with its undo name and 0.90.34's sentence", async () => {
    const e = setup();
    const ids = e.nodes.slice(0, 3).map((n) => n.id);
    act(() => e.setNodeSelection(new Set(ids)));
    const cases: [string, string, string][] = [
      ["network:align-top", "Align Top", "Aligned 3 nodes to top."],
      ["network:align-bottom", "Align Bottom", "Aligned 3 nodes to bottom."],
      ["network:align-left", "Align Left", "Aligned 3 nodes to left."],
      ["network:align-right", "Align Right", "Aligned 3 nodes to right."],
      ["network:align-hcentre", "Align Horizontal Centres", "Aligned 3 nodes to their horizontal centre."],
      ["network:align-vcentre", "Align Vertical Centres", "Aligned 3 nodes to their vertical centre."],
    ];
    for (const [id, undo, said] of cases) {
      await run(id);
      expect(e.undoManager.undoActionName).toBe(undo);
      expect(lastLog()).toBe(said);
    }
    // Spread them out again along x, then distribute.
    act(() => e.undo());
    await act(async () => Promise.resolve());
    act(() => {
      e.moveNode(ids[0], { x: 0, y: 0 }, false);
      e.moveNode(ids[1], { x: 10, y: 50 }, false);
      e.moveNode(ids[2], { x: 100, y: 100 }, false);
    });
    await act(async () => Promise.resolve());
    act(() => e.setNodeSelection(new Set(ids)));
    await run("network:distribute-h");
    expect(e.undoManager.undoActionName).toBe("Distribute Horizontally");
    expect(lastLog()).toBe("Distributed 3 nodes horizontally.");
    expect(ids.map((id) => e.node(id)!.position[0])).toEqual([0, 50, 100]);
    await run("network:distribute-v");
    expect(lastLog()).toBe("Distributed 3 nodes vertically.");
  });
});

describe("Insert Archetype and Generate Random (MENU-099, MENU-100)", () => {
  it("Insert Archetype waits under a sheet; New from Archetype never does", () => {
    setup();
    expect(reason("network:insert-archetype")).toBeNull();
    const release = holdModal();
    expect(reason("network:insert-archetype")).toBe("Close the open dialog first");
    expect(reason("file:new-from-archetype")).toBeNull();
    release();
  });
});
