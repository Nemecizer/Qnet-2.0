// The Status pane against the simulated backend, in 0.90.34's words (ledger LOG-001, LOG-009…027,
// FILE-046…048, MENU-029, MENU-047, MENU-056, KEY-025).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { savedStatusLogs } from "../../dev/mock/status";
import { defaultHandlers } from "../../dev/mockBackend";
import { getCommand, runCommand } from "../../lib/commands";
import { getSetting, loadKv } from "../../lib/kv";
import { extendMock, mockCalls, mockTauri } from "../../test/tauri";
import { handlersFor } from "../../workspace/focus";
import { addTab, getWorkspace, replaceWorkspace, setLog, tabById, type Severity, type StatusEntry } from "../../workspace/store";
import { resetSilentAnalysis } from "./analysis";
import { formattedLines, timeString } from "./entries";
import { defaultStatusFileName, defaultStatusPath } from "./exportLog";
import { StatusPane, useStatusCommands } from "./index";
import { resetPaneStates } from "./state";

const T0 = new Date(2026, 10, 11, 13, 2, 3).getTime();
let n = 0;
const entry = (text: string, severity: Severity = "info"): StatusEntry => ({ id: `E${++n}`, date: T0 + n * 1000, severity, text });

function Host() {
  useStatusCommands();
  return (
    <>
      <StatusPane />
      <DialogHost />
    </>
  );
}

function seedLog(log: StatusEntry[], init: { path?: string | null } = {}) {
  const id = "TAB-1";
  act(() => replaceWorkspace({ tabs: [{ id, title: "t", path: init.path ?? null, document: { nodes: [], links: [], infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0] }, revision: 0, savedRevision: 0, log }], activeId: id }));
  return id;
}

const rows = () => screen.queryAllByRole("option");
const rowTexts = () => rows().map((r) => r.querySelector(".status-row-text")!.textContent);
const log = () => tabById(getWorkspace().activeId)!.log;

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetPaneStates();
  resetSilentAnalysis();
  await loadKv();
});
afterEach(() => vi.restoreAllMocks());

describe("the pane", () => {
  it("greets every new tab and marks its root for focus routing (LOG-001)", async () => {
    render(<Host />);
    await waitFor(() => expect(rowTexts()).toEqual(["Ready. Choose a tool in the Tools pane to start building the network."]));
    expect(document.querySelector('[data-pane="status"]')).toBeTruthy();
    let id = "";
    act(() => {
      id = addTab();
    });
    await waitFor(() => expect(tabById(id)?.log.map((e) => e.text)).toEqual(["Ready. Choose a tool in the Tools pane to start building the network."]));
  });

  it("does not greet a restored tab that has its log", async () => {
    seedLog([entry("Opened x")]);
    render(<Host />);
    await act(async () => {});
    expect(rowTexts()).toEqual(["Opened x"]);
  });

  it("shows each row's severity, time and text; error text in the danger style (LOG-003, LOG-009)", async () => {
    const es = [entry("a"), entry("b", "success"), entry("c", "warning"), entry("d", "error")];
    seedLog(es);
    render(<Host />);
    const r = rows();
    expect(r.map((x) => x.getAttribute("data-severity"))).toEqual(["info", "success", "warning", "error"]);
    expect(within(r[3]).getByRole("img", { name: "Error" })).toBeInTheDocument();
    expect(r[0].querySelector(".status-row-time")!.textContent).toBe(timeString(es[0].date));
    expect(r[0]).not.toHaveAttribute("title");
  });

  it("counts entries in the header badge with 0.90.34's tooltip, filtered or not (LOG-010)", async () => {
    seedLog([entry("a"), entry("b", "warning"), entry("c", "error")]);
    render(<Host />);
    const badge = screen.getByText("3", { selector: ".status-count" });
    expect(badge).toHaveAttribute("title", "3 entries, 2 warnings or errors");
    fireEvent.click(screen.getByRole("radio", { name: "Errors" }));
    expect(badge).toHaveAttribute("title", "1 of 3 entries shown by the current filter · 2 warnings or errors in total");
  });

  it("has the header controls in order: Export, A− / A+, Clear (LOG-011)", () => {
    seedLog([entry("a")]);
    render(<Host />);
    const labels = [...document.querySelectorAll(".pane-header-trailing button")].map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 4)).toEqual(["Export status log", "Decrease Text Size", "Increase Text Size", "Clear Status Log"]);
  });

  it("filters by severity, Warnings including errors (LOG-013)", () => {
    seedLog([entry("a"), entry("b", "warning"), entry("c", "error"), entry("d", "success")]);
    render(<Host />);
    fireEvent.click(screen.getByRole("radio", { name: "Warnings" }));
    expect(rowTexts()).toEqual(["b", "c"]);
    fireEvent.click(screen.getByRole("radio", { name: "Errors" }));
    expect(rowTexts()).toEqual(["c"]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(rowTexts()).toHaveLength(4);
  });

  it("searches case-insensitively and trimmed, highlighting the matches (LOG-014)", () => {
    seedLog([entry("Run QNA"), entry("qna again"), entry("other")]);
    render(<Host />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search status log" }), { target: { value: "  qna " } });
    expect(rowTexts()).toEqual(["Run QNA", "qna again"]);
    expect([...document.querySelectorAll("mark.status-match")].map((m) => m.textContent)).toEqual(["QNA", "qna"]);
    expect(screen.getByRole("textbox", { name: "Search status log" }).closest("label")).toHaveAttribute(
      "title",
      "Show only the entries that contain this text. Return, ⌘G and ⇧⌘G step through the matches (⌘F). Escape clears.",
    );
  });

  it("steps through the matches with Return and ⌘G / ⇧⌘G, wrapping, with a k of n readout (LOG-015, KEY-025)", async () => {
    seedLog([entry("x1"), entry("y"), entry("x2"), entry("x3")]);
    render(<Host />);
    await act(async () => {});
    const field = screen.getByRole("textbox", { name: "Search status log" });
    fireEvent.change(field, { target: { value: "x" } });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.textContent)).toEqual([expect.stringContaining("x2")]);
    const h = handlersFor("status")!;
    expect(h.findTitle).toBe("Search Status Log…");
    expect(h.canStepFind!()).toBe(true);
    act(() => h.stepFind!(1));
    act(() => h.stepFind!(1));
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    act(() => h.stepFind!(-1));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    // Escape clears the field; with no query there is nothing to step.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("");
    expect(h.canStepFind!()).toBe(false);
  });

  it("puts the caret in the search field on ⌘F and the list first on Focus Status (LOG-016, MENU-047)", () => {
    seedLog([entry("a")]);
    render(<Host />);
    const h = handlersFor("status")!;
    act(() => h.find!());
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search status log" }));
    act(() => h.focus!());
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
  });

  it("shows the empty, no-results and cleared states (LOG-018)", async () => {
    seedLog([]);
    render(<Host />);
    await act(async () => {});
    act(() => setLog(getWorkspace().activeId, []));
    expect(screen.getByText("No Status Entries")).toBeInTheDocument();
    expect(screen.getByText("Solver output and warnings appear here.")).toBeInTheDocument();
    act(() => setLog(getWorkspace().activeId, [entry("a")]));
    fireEvent.change(screen.getByRole("textbox", { name: "Search status log" }), { target: { value: "zz" } });
    expect(screen.getByText("No Results for “zz”")).toBeInTheDocument();
    expect(screen.getByText("Check the spelling or try a different search.")).toBeInTheDocument();
  });

  it("changes the text size with A− / A+ and the zoom handlers, within 8–28 (LOG-012)", async () => {
    seedLog([entry("a")]);
    render(<Host />);
    const list = screen.getByRole("listbox");
    expect(list.closest(".status-pane")).toHaveStyle({ "--status-fs": "12px" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Increase Text Size" })));
    expect(getSetting("status.fontSize", 0)).toBe(13);
    await act(async () => handlersFor("status")!.zoom!(-1));
    await act(async () => handlersFor("status")!.zoom!(-1));
    expect(getSetting("status.fontSize", 0)).toBe(11);
    expect(handlersFor("status")!.canZoom!(1)).toBe(true);
  });

  it("follows new entries only while scrolled to the bottom (LOG-017)", async () => {
    seedLog([entry("a"), entry("b")]);
    render(<Host />);
    const list = screen.getByRole("listbox");
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 100 });
    act(() => setLog(getWorkspace().activeId, [...log(), entry("c")]));
    expect(list.scrollTop).toBe(1000);
    list.scrollTop = 200;
    fireEvent.scroll(list);
    act(() => setLog(getWorkspace().activeId, [...log(), entry("d")]));
    expect(list.scrollTop).toBe(200);
  });

  it("has no size limit (LOG-027)", () => {
    seedLog(Array.from({ length: 3000 }, (_, i) => entry(`line ${i}`)));
    render(<Host />);
    expect(rows()).toHaveLength(3000);
  });
});

describe("selection and copying", () => {
  let clip: string[];
  beforeEach(() => {
    clip = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void clip.push(t) } });
  });

  it("multi-selects with ⌘-click and ⇧-click; ⌘C copies the selected entries (LOG-019)", () => {
    const es = [entry("a"), entry("b", "warning"), entry("c"), entry("d")];
    seedLog(es);
    render(<Host />);
    fireEvent.mouseUp(rows()[0], { button: 0 });
    fireEvent.mouseUp(rows()[2], { button: 0, shiftKey: true });
    fireEvent.mouseUp(rows()[1], { button: 0, metaKey: true });
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "true", "false"]);
    const data = new Map<string, string>();
    fireEvent.copy(screen.getByRole("listbox"), { clipboardData: { setData: (k: string, v: string) => data.set(k, v) } });
    expect(data.get("text/plain")).toBe(formattedLines([es[0], es[2]]));
  });

  it("copies the visible entries in 0.90.34's form and says so in the log (LOG-020, LOG-021)", async () => {
    const es = [entry("a"), entry("b", "warning"), entry("c", "error")];
    seedLog(es);
    render(<Host />);
    fireEvent.click(screen.getByRole("radio", { name: "Warnings" }));
    fireEvent.click(screen.getByRole("button", { name: "Export status log" }));
    const menu = screen.getByRole("menu", { name: "Export status log" });
    expect(within(menu).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("aria-disabled")])).toEqual([
      ["Copy All", null],
      ["Copy Selected", "true"],
      ["Save Status Log…", null],
    ]);
    await act(async () => fireEvent.click(within(menu).getByText("Copy All")));
    expect(clip).toEqual([`[${timeString(es[1].date)}] [WARNING] b\n[${timeString(es[2].date)}] [ERROR] c`]);
    expect(log().at(-1)).toMatchObject({ text: "Copied 2 status entries to the clipboard.", severity: "success" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Copy Selected with nothing selected copies everything visible; one entry reads “entry”", async () => {
    seedLog([entry("only")]);
    render(<Host />);
    fireEvent.contextMenu(screen.getByRole("listbox"), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("aria-disabled")])).toEqual([
      ["Copy", "true"],
      ["Copy All", null],
      ["Clear Status Log", null],
    ]);
    await act(async () => fireEvent.click(within(menu).getByText("Copy All")));
    expect(log().at(-1)!.text).toBe("Copied 1 status entry to the clipboard.");
  });

  it("disables the whole Export menu when the log is empty", async () => {
    seedLog([]);
    render(<Host />);
    act(() => setLog(getWorkspace().activeId, []));
    expect(screen.getByRole("button", { name: "Export status log" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Status Log" })).toBeDisabled();
  });

  it("closes a menu with Escape or a click outside it", () => {
    seedLog([entry("a")]);
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Export status log" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(rows()[0], { clientX: 5, clientY: 5 });
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Clear Status Log and Undo Clear", () => {
  it("clears a short log at once, leaving it empty, and Undo Clear puts it back above newer lines (LOG-025, LOG-026)", async () => {
    const es = [entry("a"), entry("b")];
    seedLog(es);
    render(<Host />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear Status Log" })));
    expect(log()).toEqual([]);
    expect(screen.getByText("Status Log Cleared")).toBeInTheDocument();
    expect(screen.getByText("2 entries were removed. Solver output and warnings appear here.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const later = entry("later");
    act(() => setLog(getWorkspace().activeId, [later]));
    // The undo survives the pane going away (the backlog is the tab's).
    act(() => setLog(getWorkspace().activeId, []));
    fireEvent.click(screen.getByRole("button", { name: "Undo Clear" }));
    expect(log().map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("asks first when the log has more than 20 entries, in 0.90.34's words", async () => {
    seedLog(Array.from({ length: 21 }, (_, i) => entry(`l${i}`)));
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Status Log" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Clear the status log?");
    expect(dialog).toHaveTextContent("All 21 entries will be removed and will not be restored on the next launch. Copy All keeps a copy first; Undo Clear in the empty log brings them back until the next clear.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(log()).toHaveLength(21);
    fireEvent.click(screen.getByRole("button", { name: "Clear Status Log" }));
    const again = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Clear Status Log" })));
    expect(log()).toEqual([]);
  });

  it("does not ask for exactly 20", async () => {
    seedLog(Array.from({ length: 20 }, (_, i) => entry(`l${i}`)));
    render(<Host />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear Status Log" })));
    expect(log()).toEqual([]);
  });

  it("Edit ▸ Clear Status Log is the same command, disabled on an empty log (MENU-056)", async () => {
    seedLog([entry("a")]);
    render(<Host />);
    const c = getCommand("edit:clear-status-log")!;
    expect(c.subtitle).toBe("Empty the Status pane (asks first once the log is long; Undo Clear in the empty pane brings it back)");
    expect(c.when!()).toBe(true);
    await act(async () => void (await runCommand("edit:clear-status-log")));
    expect(log()).toEqual([]);
    expect(c.when!()).toBe("The status log is empty");
    expect(getCommand("file:export-status-log")!.when!()).toBe("The status log is empty");
  });
});

describe("Save Status Log…", () => {
  it("suggests <network>-status.txt in the document's folder, or Untitled-status.txt (LOG-022, FILE-046)", () => {
    expect(defaultStatusFileName({ path: null })).toBe("Untitled-status.txt");
    expect(defaultStatusFileName({ path: "/Users/a/nets/tandem.bnet" })).toBe("tandem-status.txt");
    expect(defaultStatusFileName({ path: "/x/15stationtandem.inf.bnet" })).toBe("15stationtandem.inf-status.txt");
    expect(defaultStatusPath({ path: "/Users/a/nets/tandem.bnet" })).toBe("/Users/a/nets/tandem-status.txt");
  });

  it("writes the visible entries from the pane and the whole log from the menu bar, then reports it (LOG-023, LOG-024, FILE-047, FILE-048, MENU-029)", async () => {
    const es = [entry("a"), entry("b", "error")];
    seedLog(es, { path: "/Users/preview/nets/tandem.bnet" });
    let asked: unknown = null;
    extendMock({ "plugin:dialog|save": ({ options }: { options: unknown }) => ((asked = options), "/Users/preview/nets/tandem-status.txt") });
    render(<Host />);
    fireEvent.click(screen.getByRole("radio", { name: "Errors" }));
    fireEvent.click(screen.getByRole("button", { name: "Export status log" }));
    await act(async () => fireEvent.click(screen.getByText("Save Status Log…")));
    await waitFor(() => expect(log().at(-1)?.text).toBe("Saved 1 status entry to ~/nets/tandem-status.txt."));
    expect(asked).toMatchObject({ title: "Save Status Log", defaultPath: "/Users/preview/nets/tandem-status.txt", filters: [{ name: "Plain Text", extensions: ["txt"] }], canCreateDirectories: true });
    expect(savedStatusLogs["/Users/preview/nets/tandem-status.txt"]).toBe(formattedLines([es[1]]) + "\n");
    expect(log().at(-1)!.severity).toBe("success");

    await act(async () => void (await runCommand("file:export-status-log")));
    expect(savedStatusLogs["/Users/preview/nets/tandem-status.txt"]).toBe(formattedLines(log().slice(0, -1)) + "\n");
    expect(log().at(-1)!.text).toBe("Saved 3 status entries to ~/nets/tandem-status.txt.");
    expect(getCommand("file:export-status-log")!.subtitle).toBe("Write the Status pane's entries, with timestamps and severities, to a text file");
  });

  it("does nothing when the panel is cancelled, and reports a failed write", async () => {
    seedLog([entry("a")]);
    render(<Host />);
    extendMock({ "plugin:dialog|save": () => null });
    await act(async () => void (await runCommand("file:export-status-log")));
    expect(log()).toHaveLength(1);
    extendMock({ "plugin:dialog|save": () => "/readonly/x.txt" });
    await act(async () => void (await runCommand("file:export-status-log")));
    await waitFor(() => expect(log().at(-1)).toMatchObject({ text: "Could not save the status log: Permission denied (os error 13)", severity: "error" }));
    expect(mockCalls.some((c) => c.cmd === "status_log_write")).toBe(true);
  });

  it("says there is nothing to save for an empty log", async () => {
    const { saveStatusLog } = await import("./exportLog");
    const id = seedLog([]);
    await act(() => saveStatusLog(id));
    expect(log()).toEqual([expect.objectContaining({ text: "Nothing to save — the status log is empty.", severity: "warning" })]);
  });
});
