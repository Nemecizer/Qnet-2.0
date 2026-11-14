// The Edit menu's document commands (ledger §1.3, CAN-171…183): titles that name the step, the
// text-field-first routing, the sheet rule, and Clear Canvas's confirmation.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DialogHost } from "../components/DialogHost";
import { getCommand, registerCommands, titleOf, unavailableReason } from "../lib/commands";
import { holdModal } from "../lib/overlays";
import { defaultHandlers } from "../dev/mockBackend";
import { mockCalls, mockTauri } from "../test/tauri";
import { activeTab } from "../workspace/store";
import { activeEditor } from ".";
import { editCommands } from "./commands";
import { trackFieldEdits } from "./fieldEdits";

const cmd = (id: string) => getCommand(id)!;
const reason = (id: string) => unavailableReason(cmd(id));
const tick = () => Promise.resolve();

async function station(x: number) {
  const e = activeEditor();
  e.setTool("addStation");
  e.handleCanvasTap({ x, y: 0 });
  await tick();
}

describe("Edit ▸ Undo and Redo", () => {
  it("name the step, round-trip, and say so in the log (MENU-032/033, CAN-172/173)", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    expect(titleOf(cmd("edit:undo"))).toBe("Undo");
    expect(reason("edit:undo")).toBe("Nothing to undo");
    await station(0);
    expect(titleOf(cmd("edit:undo"))).toBe("Undo Add Station");
    cmd("edit:undo").run();
    expect(activeEditor().nodes).toHaveLength(0);
    expect(titleOf(cmd("edit:redo"))).toBe("Redo Add Station");
    cmd("edit:redo").run();
    expect(activeEditor().nodes.map((n) => n.name)).toEqual(["S1"]);
    expect(activeTab().log.slice(-2).map((l) => l.text)).toEqual(["Undid: Add Station.", "Redid: Add Station."]);
  });

  it("go to a focused text field only when it has typing of its own, else to the document and let go of the field (MENU-034)", async () => {
    mockTauri({ ...defaultHandlers(), native_edit: () => null });
    registerCommands(editCommands());
    const stop = trackFieldEdits(document);
    render(<input aria-label="Name" />);
    await station(0);
    const field = screen.getByLabelText("Name");
    field.focus();
    // Only clicked into: ⌘Z is the document's, and the stale field lets go.
    expect(titleOf(cmd("edit:undo"))).toBe("Undo Add Station");
    cmd("edit:undo").run();
    expect(activeEditor().nodes).toHaveLength(0);
    expect(document.activeElement).not.toBe(field);
    // Typed into: ⌘Z is the field's, sent down the responder chain.
    field.focus();
    fireEvent.input(field, { target: { value: "x" } });
    expect(titleOf(cmd("edit:undo"))).toBe("Undo");
    expect(reason("edit:undo")).toBeNull();
    cmd("edit:undo").run();
    expect(mockCalls.filter((c) => c.cmd === "native_edit").map((c) => c.args.action)).toEqual(["undo"]);
    // The field's one edit is undone: the next ⌘Z would be the document's again (nothing left there).
    expect(reason("edit:undo")).toBe("Nothing to undo");
    expect(titleOf(cmd("edit:redo"))).toBe("Redo");
    stop();
  });
});

describe("the clipboard trio and the sheet rule", () => {
  it("routes ⌘C, ⌘X, ⌘V and ⌘A to a focused field, and to the canvas otherwise (MENU-035/036/038/042)", async () => {
    mockTauri({ ...defaultHandlers(), native_edit: () => null });
    registerCommands(editCommands());
    await station(0);
    activeEditor().selectAll();
    cmd("edit:copy").run();
    expect(activeTab().log.at(-1)!.text).toBe("Copied 1 node.");
    cmd("edit:paste").run();
    await tick();
    expect(activeEditor().nodes.map((n) => n.name)).toEqual(["S1", "S2"]);
    render(<input aria-label="Name" />);
    screen.getByLabelText("Name").focus();
    for (const id of ["edit:copy", "edit:cut", "edit:paste", "edit:select-all"]) cmd(id).run();
    expect(mockCalls.filter((c) => c.cmd === "native_edit").map((c) => c.args.action)).toEqual(["copy", "cut", "paste", "selectAll"]);
    expect(activeEditor().nodes).toHaveLength(2);
  });

  it("keeps Cut, Paste, Duplicate, Delete and Clear Canvas off under a dialog; Copy stays live (MENU-035…041, MENU-198)", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    await station(0);
    activeEditor().selectAll();
    const release = holdModal();
    for (const id of ["edit:cut", "edit:paste", "edit:duplicate", "edit:delete", "edit:clear-canvas", "edit:parameters"]) expect(reason(id), id).toBe("Close the open dialog first");
    expect(reason("edit:copy")).toBeNull();
    release();
    expect(reason("edit:duplicate")).toBeNull();
  });

  it("dims Duplicate, Delete and Edit Parameters while a text field has the keyboard (MENU-039/040/054)", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    await station(0);
    render(<input aria-label="Name" />);
    screen.getByLabelText("Name").focus();
    for (const id of ["edit:duplicate", "edit:delete", "edit:parameters"]) expect(reason(id), id).toBe("A text field has the keyboard");
  });

  it("enables Deselect All and Delete Selected Link only when there is something to act on (MENU-041/043)", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    expect(reason("edit:deselect-all")).toBe("Select a node or a link first");
    expect(reason("edit:delete-link")).toBe("Select a link first");
    await station(0);
    expect(reason("edit:deselect-all")).toBeNull();
  });
});

describe("Edit ▸ Clear Canvas…", () => {
  it("confirms in 0.90.34's words and is one undoable step (MENU-055, CAN-178, WS-106)", async () => {
    mockTauri(defaultHandlers());
    registerCommands(editCommands());
    expect(reason("edit:clear-canvas")).toBe("The canvas is empty");
    render(<DialogHost />);
    await station(0);
    await station(100);
    const run = cmd("edit:clear-canvas").run() as Promise<void>;
    expect(await screen.findByText("Clear the canvas?")).toBeTruthy();
    expect(screen.getByText("Every node and link in “Untitled” will be removed. This can be undone with Edit ▸ Undo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear Canvas" }));
    await run;
    expect(activeEditor().nodes).toHaveLength(0);
    expect(activeTab().log.at(-1)!.text).toBe("Canvas cleared. Edit ▸ Undo brings the network back.");
    await tick();
    cmd("edit:undo").run();
    expect(activeEditor().nodes.map((n) => n.name)).toEqual(["S1", "S2"]);
    // The counters came back too: the next station is S3.
    await station(200);
    expect(activeEditor().nodes.at(-1)!.name).toBe("S3");
  });
});
