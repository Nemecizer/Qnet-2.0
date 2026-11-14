// Where the P5 areas meet: the integration review's findings, kept fixed.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CountField, parseCount } from "../components/CountField";
import { CanvasController, type PointerInput } from "../canvas/interaction/controller";
import { getCommand, registerCommands, unavailableReason } from "../lib/commands";
import { holdModal } from "../lib/overlays";
import { defaultHandlers } from "../dev/mockBackend";
import { mockTauri } from "./tauri";
import { activeEditor } from "../editor";
import { editCommands } from "../editor/commands";
import { getWorkspace, setDocument } from "../workspace/store";

const at = (x: number, y: number, mods: Partial<PointerInput> = {}): PointerInput => ({ x, y, shift: false, meta: false, alt: false, ctrl: false, ...mods });

async function station(x: number, y = 100) {
  const e = activeEditor();
  e.setTool("addStation");
  e.handleCanvasTap({ x, y });
  await Promise.resolve();
  e.setTool("select");
}

describe("a drag that panning interrupts", () => {
  it("keeps the move to its release when Space turns panning on mid-drag, and ends its mutation", async () => {
    mockTauri(defaultHandlers());
    await station(100);
    const e = activeEditor();
    e.setViewportSize({ width: 800, height: 600 });
    const c = new CanvasController(e, () => e.makeScene(), () => {});
    c.pointerDown(at(100, 100));
    c.pointerMove(at(130, 100));
    e.setView({ isSpacePanning: true });
    c.pointerMove(at(160, 100));
    c.pointerUp(at(160, 100));
    expect(e.nodes[0].position).toEqual([160, 100]);
    expect(e.view.isDraggingNode).toBe(false);
    expect(e.mutationOpen).toBe(false);
    expect(e.undoManager.undoActionName).toBe("Move Node");
  });

  it("ends a drag still in flight when the canvas goes away", async () => {
    mockTauri(defaultHandlers());
    await station(100);
    const e = activeEditor();
    const c = new CanvasController(e, () => e.makeScene(), () => {});
    c.pointerDown(at(100, 100));
    c.pointerMove(at(150, 100));
    c.dispose();
    expect(e.view.isDraggingNode).toBe(false);
    expect(e.mutationOpen).toBe(false);
  });
});

describe("Edit ▸ Undo under a parameters panel", () => {
  it("waits while a document-modal panel is up, so the panel's draft can't be pulled out from under it", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    await station(100);
    const release = holdModal();
    expect(unavailableReason(getCommand("edit:undo")!)).toBe("Close the open dialog first");
    getCommand("edit:undo")!.run();
    expect(activeEditor().nodes).toHaveLength(1);
    release();
    expect(unavailableReason(getCommand("edit:undo")!)).toBeNull();
  });
});

describe("a file opened into a tab with a history", () => {
  it("starts its own undo history, so ⌘Z can't put the earlier network back over it", async () => {
    mockTauri(defaultHandlers());
    await station(100);
    const e = activeEditor();
    e.selectAll();
    e.deleteSelection();
    await Promise.resolve();
    expect(e.undoManager.canUndo).toBe(true);
    // What Open into a blank tab does: the store's document replaced from outside the editor.
    setDocument(getWorkspace().activeId, { nodes: [], links: [], infiniteBuffers: true, canvasScale: 1, canvasPanOffset: [0, 0] });
    expect(e.undoManager.canUndo).toBe(false);
  });
});

describe("value-backed count fields (INS-138, INS-141)", () => {
  function Harness({ onValue }: { onValue: (v: string) => void }) {
    const [v, setV] = useState("4");
    return (
      <CountField
        id="n"
        label="Stations"
        value={v}
        min={1}
        max={20}
        decrementLabel="Fewer"
        incrementLabel="More"
        onChange={(x) => {
          setV(x);
          onValue(x);
        }}
      />
    );
  }

  it("reads 1e3 as a whole number, and nothing that isn't whole", () => {
    expect(parseCount("1e3")).toBe(1000);
    expect(parseCount("1,000")).toBe(1000);
    expect(parseCount("2.5")).toBeNull();
    expect(parseCount("1e16")).toBeNull();
  });

  it("clamps an out-of-range commit and says so for 2.5 s or until the next keystroke; reverts unparsable text", () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      render(<Harness onValue={(x) => seen.push(x)} />);
      const f = screen.getByLabelText("Stations") as HTMLInputElement;
      fireEvent.change(f, { target: { value: "99" } });
      fireEvent.blur(f);
      expect(f.value).toBe("20");
      expect(screen.getByRole("status").textContent).toBe("Clamped to 20");
      act(() => void vi.advanceTimersByTime(2600));
      expect(screen.queryByRole("status")).toBeNull();
      fireEvent.change(f, { target: { value: "abc" } });
      fireEvent.keyDown(f, { key: "Enter" });
      expect(f.value).toBe("20");
      fireEvent.change(f, { target: { value: "1e1" } });
      fireEvent.blur(f);
      expect(f.value).toBe("10");
    } finally {
      vi.useRealTimers();
    }
  });
});
