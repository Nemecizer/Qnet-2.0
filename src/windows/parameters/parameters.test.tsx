// The Node and Link Parameters panels, the Station Picture picker, Find Node and the panel host
// (ledger 4.8, 4.10, 4.11, 4.16, WS-101…104, SET-206, MENU-054, CAN-215, CAN-216), rendered into
// real (iframe) windows as AuxWindow opens them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { editCommands } from "../../editor/commands";
import { editorClock } from "../../editor";
import { loadKv } from "../../lib/kv";
import { modalOpen } from "../../lib/overlays";
import { heightForRows, isPanelOpen, panelFrameKey, PANEL_BANDS } from "../../lib/panel";
import { mockTauri } from "../../test/tauri";
import { linkBetween, nodeNamed, openExample, statusLines } from "../../panes/inspector/testing";
import { PicturePicker } from "../../panes/inspector/PicturePicker";
import { ParametersHost } from ".";
import { nodePanelBand, nodePanelHeight } from "./sizes";
import { extendedWords as xw } from "../../extended/words";

const frames: HTMLIFrameElement[] = [];
let opened: { name: string; win: Window }[] = [];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  await loadKv();
  editorClock.now = () => 1_000_000;
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
afterEach(() => {
  frames.splice(0).forEach((f) => f.remove());
});

const panel = (name: string) => {
  const o = [...opened].reverse().find((x) => x.name === `qnet-panel-${name}`);
  if (!o) throw new Error(`no window ${name}`);
  return within(o.win.document.body);
};

function show(stem: string) {
  const e = openExample(stem);
  render(<ParametersHost />);
  return e;
}

describe("the Node Parameters panel (INS-089…107)", () => {
  it("opens on ⌘I for the selected node, titled, document-modal, and saves as one undo step", async () => {
    const e = show("MM1K.d1.c1.fin");
    act(() => e.setView({ selectedNodeID: nodeNamed(e, "S1").id }));
    const cmd = editCommands().find((c) => c.id === "edit:parameters")!;
    expect(cmd.when!()).toBe(true);
    act(() => void cmd.run());
    const p = panel("node-parameters");
    expect(await p.findByRole("heading", { name: "S1" })).toBeInTheDocument();
    expect(opened.at(-1)!.win.document.title).toBe("Node Parameters");
    expect(isPanelOpen("node-parameters")).toBe(true);
    expect(modalOpen()).toBe(true);
    // CAN-216 / INS-094: while it is up, Edit Parameters waits.
    expect(cmd.when!()).toBe("Close the open dialog first");
    await waitFor(() => expect(p.getByText("Station · 1 server · 1 class · ρ 0.9")).toBeInTheDocument());
    // INS-104: the Name field has the keyboard.
    expect(opened.at(-1)!.win.document.activeElement).toBe(p.getByRole("textbox", { name: "Name" }));
    fireEvent.change(p.getByRole("textbox", { name: "Number of servers" }), { target: { value: "2" } });
    fireEvent.change(p.getByRole("textbox", { name: "Class 1 Rate (λ)" }), { target: { value: "0.5" } });
    fireEvent.click(p.getByRole("button", { name: "Save" }));
    expect(nodeNamed(e, "S1").numberOfServers).toBe(2);
    expect(nodeNamed(e, "S1").serviceDistributions["0"]).toEqual({ distribution: "exponential", distributionParameters: "rate=0.5" });
    expect(statusLines().at(-1)).toBe("Edited S1: servers 1 → 2; Class 1 → Exponential(λ=0.5); default service law follows Class 1.");
    expect(e.undoManager.undoActionName).toBe("Edit S1 Parameters");
    expect(e.view.parameterEditorTarget).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => e.undo());
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
    expect(nodeNamed(e, "S1").serviceDistributions).toEqual({});
  });

  // Review finding FIX-208c: the sheet lacked the sections the docked Inspector has for a
  // station's order of service and a source's batches and rate over time.
  it("has the Service Order, Batch Arrivals and Rate Over Time sections, written at once and not by Save", async () => {
    const e = show("3d2ctandem.inf");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    const order = await p.findByRole("region", { name: xw.orderSection });
    expect(p.getByRole("note")).toHaveTextContent(xw.appliesAtOnce);
    fireEvent.change(within(order).getByRole("combobox", { name: xw.discipline }), { target: { value: "priorityPreemptiveResume" } });
    // Written at once, as its own undo step; the sheet's own draft is untouched by it.
    expect(nodeNamed(e, "S1")).toMatchObject({ serviceDiscipline: "priorityPreemptiveResume", priorityOrder: [0, 1] });
    expect(e.undoManager.undoActionName).toBe("Change Service Discipline");
    fireEvent.click(within(order).getByRole("button", { name: xw.moveUp("Class 2") }));
    expect(nodeNamed(e, "S1").priorityOrder).toEqual([1, 0]);
    // Cancel closes without a prompt (nothing waits for Save) and keeps what was written.
    fireEvent.click(p.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(isPanelOpen("node-parameters")).toBe(false));
    expect(nodeNamed(e, "S1").serviceDiscipline).toBe("priorityPreemptiveResume");

    const source = e.nodes.find((n) => n.kind === "source")!;
    act(() => e.openParameterEditor(source.id));
    const q = panel("node-parameters");
    const batch = await q.findByRole("region", { name: xw.batchSection });
    expect(q.getByRole("region", { name: xw.profileSection })).toBeInTheDocument();
    fireEvent.change(within(batch).getByRole("combobox", { name: xw.batchKind }), { target: { value: "constant" } });
    expect(e.nodes.find((n) => n.id === source.id)!.batchSize?.kind).toBe("constant");
    // A buffer has neither, and no note.
    fireEvent.click(q.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(isPanelOpen("node-parameters")).toBe(false));
    act(() => e.openParameterEditor(nodeNamed(e, "B1").id));
    const b = panel("node-parameters");
    await b.findByRole("heading", { name: "B1" });
    expect(b.queryByRole("note")).toBeNull();
    expect(b.queryByRole("region", { name: xw.orderSection })).toBeNull();
  });

  it("says No changes on an untouched Save", async () => {
    const e = show("MM1K.d1.c1.fin");
    act(() => e.openParameterEditor(nodeNamed(e, "Sink1").id));
    const p = panel("node-parameters");
    fireEvent.click(await p.findByRole("button", { name: "Save" }));
    expect(statusLines().at(-1)).toBe("No changes to Sink1.");
  });

  it("asks before closing a dirty draft, and Don't Save discards it (INS-102, INS-103)", async () => {
    const e = show("MM1K.d1.c1.fin");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    fireEvent.change(await p.findByRole("textbox", { name: "Number of servers" }), { target: { value: "4" } });
    expect(p.getByRole("button", { name: "Cancel" })).toHaveAttribute("title", "Close without saving — asks first (Esc)");
    fireEvent.keyDown(p.getByRole("textbox", { name: "Number of servers" }), { key: "Escape" });
    const prompt = p.getByRole("alertdialog");
    expect(prompt).toHaveTextContent("Save changes to S1 before closing?");
    expect(prompt).toHaveTextContent("The edits to this node have not been saved. Saving commits them as one undo step.");
    fireEvent.click(within(prompt).getByRole("button", { name: "Don’t Save" }));
    expect(e.view.parameterEditorTarget).toBeNull();
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
  });

  it("blocks Save on an invalid draft and says why in the prompt", async () => {
    const e = show("MM1K.d1.c1.fin");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    fireEvent.change(await p.findByRole("textbox", { name: "Number of servers" }), { target: { value: "0" } });
    expect(p.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(p.getByLabelText("Cannot continue: Servers must be ≥ 1.")).toBeInTheDocument();
    fireEvent.click(p.getByRole("button", { name: "Cancel" }));
    expect(p.getByRole("alertdialog")).toHaveTextContent("The edits to this node have not been saved and cannot be saved as they are (Servers must be ≥ 1.).");
    expect(within(p.getByRole("alertdialog")).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(p.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(e.view.parameterEditorTarget).toBe(nodeNamed(e, "S1").id);
  });

  it("steps through stations in export order with ⌥↓, its ends disabled (INS-097…099)", async () => {
    const e = show("2dtandem");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    expect(await p.findByText("1 of 2")).toHaveAttribute("title", "This is station 1 of 2, in the order the solvers number them");
    expect(p.getByRole("button", { name: "Previous station" })).toBeDisabled();
    expect(p.getByRole("button", { name: "Next station" })).toHaveAttribute("title", "Edit S2 (⌥↓)");
    fireEvent.keyDown(p.getByRole("textbox", { name: "Name" }), { key: "ArrowDown", altKey: true });
    expect(await p.findByRole("heading", { name: "S2" })).toBeInTheDocument();
    expect(e.view.selectedNodeID).toBe(nodeNamed(e, "S2").id);
    expect(p.getByRole("button", { name: "Next station" })).toBeDisabled();
  });

  it("opens an outgoing link from its Routing row in the Link Parameters panel (INS-078)", async () => {
    const e = show("2dtandem");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    fireEvent.click(await p.findByRole("button", { name: "Class 1 to B2, probability 1" }));
    expect(e.view.parameterEditorTarget).toBeNull();
    await waitFor(() => expect(e.view.linkParameterEditorTarget).toBe(linkBetween(e, "S1", "B2").id), { timeout: 1500 });
  });

  it("closes when its node is deleted under it (deleteNode clears the target)", async () => {
    const e = show("2dtandem");
    act(() => e.openParameterEditor(nodeNamed(e, "Sink1").id));
    const p = panel("node-parameters");
    await p.findByRole("heading", { name: "Sink1" });
    act(() => e.deleteNode(nodeNamed(e, "Sink1").id));
    expect(e.view.parameterEditorTarget).toBeNull();
    expect(isPanelOpen("node-parameters")).toBe(false);
  });

  it("bands a sink compact, a buffer regular, a source wide and a class-table station by the order (INS-106, INS-107)", () => {
    const e = openExample("2dtandem");
    expect(nodePanelBand(e, nodeNamed(e, "Sink1").id)).toBe("compact");
    expect(nodePanelBand(e, nodeNamed(e, "B1").id)).toBe("regular");
    expect(nodePanelBand(e, nodeNamed(e, "Src1").id)).toBe("wide");
    expect(nodePanelBand(e, nodeNamed(e, "S1").id)).toBe("table");
    // Two stations with one class each and two links each: 624 + 40 × (1 + 2).
    expect(nodePanelHeight(e, nodeNamed(e, "S1").id)).toBe(heightForRows("table", 3));
    expect(heightForRows("table", 3)).toBe(744);
    expect(PANEL_BANDS.table).toMatchObject({ minWidth: 760, idealWidth: 800, maxWidth: 1000 });
    expect(panelFrameKey("node-parameters")).toBe("WindowFrame.QnetPanel.node-parameters");
  });
});

describe("the per-class table's bulk actions (INS-062…064)", () => {
  it("copies Class 1 to the other rows with a one-level revert in the footer", async () => {
    const e = show("KumarSeidman90.d2.c4.reentrant.inf");
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    expect(await p.findByRole("table", { name: "Service time per class table, 2 rows" })).toBeInTheDocument();
    fireEvent.click(p.getByRole("button", { name: "Apply" }));
    fireEvent.click(p.getByRole("menuitem", { name: "Copy Class 1 to 1 Other Class" }));
    expect(p.getByText("Class 1 copied to 1 class")).toBeInTheDocument();
    expect(p.getAllByRole("textbox", { name: /Class \d Rate \(λ\)/ }).map((f) => (f as HTMLInputElement).value)).toEqual(["10", "10"]);
    fireEvent.click(p.getByRole("button", { name: "Undo Copy to All Classes" }));
    expect(p.queryByText("Class 1 copied to 1 class")).toBeNull();
    expect(p.getAllByRole("textbox", { name: /Class \d Rate \(λ\)/ }).map((f) => (f as HTMLInputElement).value)).toEqual(["10", "1.666667"]);
  });
});

describe("the Link Parameters panel (INS-124…128)", () => {
  it("edits the probability and the exit class, saved as Edit Link", async () => {
    const e = show("2dtandem");
    act(() => e.setView({ selectedLinkID: linkBetween(e, "S1", "B2").id }));
    act(() => e.openParameterEditorForSelection());
    const p = panel("link-parameters");
    expect(await p.findByRole("heading", { name: "S1 → B2" })).toBeInTheDocument();
    expect(p.getByText("Routing link · Class 1")).toBeInTheDocument();
    fireEvent.change(p.getByRole("textbox", { name: "Routing probability" }), { target: { value: "0.4" } });
    fireEvent.change(p.getByRole("combobox", { name: "Exit class, same as entry" }), { target: { value: "1" } });
    expect(p.getByText("Routing link · Class 1 → Class 2")).toBeInTheDocument();
    expect(p.getByText("Jobs enter as Class 1 and leave as Class 2 — a class transition (Dai–Harrison re-entrant line).")).toBeInTheDocument();
    fireEvent.click(p.getByRole("button", { name: "Save" }));
    const l = linkBetween(e, "S1", "B2");
    expect(l.routingProbability).toBe(0.4);
    expect(l.toCustomerClass).toBe(1);
    expect(statusLines().at(-1)).toBe("Edited link S1 → B2: probability 1 → 0.4; exit class → Class 2.");
    expect(e.undoManager.undoActionName).toBe("Edit Link S1 → B2");
  });

  it("says Still typing for a half-typed probability", async () => {
    const e = show("2dtandem");
    act(() => e.openLinkParameterEditor(linkBetween(e, "S1", "B2").id));
    const p = panel("link-parameters");
    fireEvent.change(await p.findByRole("textbox", { name: "Routing probability" }), { target: { value: "1e-" } });
    expect(p.getByText("Still typing Probability")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("the Station Picture picker (INS-129)", () => {
  it("walks the tiles with the arrows, clamped, and chooses with Return", () => {
    const chosen: string[] = [];
    render(<PicturePicker current="" onChoose={(sf) => chosen.push(sf)} onCancel={() => chosen.push("cancel")} />);
    const form = screen.getByRole("heading", { name: "Station Picture" }).closest(".panel-form")!;
    expect(screen.getByRole("option", { name: "No Picture, current picture" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(form, { key: "ArrowLeft" });
    expect(screen.getByRole("option", { name: "No Picture, current picture" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(form, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Machine" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(form, { key: "ArrowRight" });
    fireEvent.keyDown(form, { key: "Enter" });
    expect(chosen).toEqual(["hammer.fill"]);
    fireEvent.doubleClick(screen.getByRole("option", { name: "Gear" }));
    expect(chosen.at(-1)).toBe("gear");
    fireEvent.keyDown(form, { key: "Escape" });
    expect(chosen.at(-1)).toBe("cancel");
    expect(screen.getByText("Service Industry")).toBeInTheDocument();
  });
});
