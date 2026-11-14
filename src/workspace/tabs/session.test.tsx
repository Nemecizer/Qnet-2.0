// Session restore and quit (ledger 5.10, FILE-054, FILE-055, MENU-007, CAN-133, CAN-134).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { quitCalls } from "../../dev/mock/core";
import { mockSession } from "../../dev/mock/session";
import { getSetting, getStateValue, loadKv } from "../../lib/kv";
import { mockTauri, type MockHandlers } from "../../test/tauri";
import { addStatus, addTab, getWorkspace, isDirty, markSaved, moveTab, selectTab, setDocument, updateTab } from "../store";
import {
  changesSnapshot, fileUrlToPath, fromSwiftDate, hasRestorableContent, inferSeverity, legacyEntry, pathToFileUrl, quit, resetSession,
  restoreSession, SAVE_DEBOUNCE_MS, shortDateTime, snapshot, startAutosave, tabsFromSnapshot, toSwiftDate, URLS_KEY,
} from "./session";
import { docWith, seed, tab, answer } from "./testkit";

function backend(opts: Parameters<typeof defaultHandlers>[0] & { session?: unknown } = {}, extra: MockHandlers = {}) {
  mockTauri({ ...defaultHandlers(opts), ...extra });
}

beforeEach(() => {
  resetSession();
  quitCalls.count = 0;
});
afterEach(() => {
  vi.useRealTimers();
  resetSession();
});

const entry = (id: string, more: Record<string, unknown> = {}) => ({ id, title: `${id}.bnet`, document: docWith(1), userFileURL: `file:///Users/me/My%20Nets/${id}.bnet`, statusLog: [], ...more });

describe("the snapshot (WS-127, WS-129, FILE-054)", () => {
  it("holds every tab's id, title, document, file and log, and the active tab, in 0.90.34's shape", () => {
    const document = docWith(2, { canvasScale: 2, canvasPanOffset: [10, 20], infiniteBuffers: true });
    seed([tab("A", { path: "/Users/me/My Nets/a.bnet", document, log: [{ id: "L", date: Date.UTC(2026, 0, 1), severity: "warning", text: "Careful" }] }), tab("B")], "B");
    const s = snapshot();
    expect(s.activeTabID).toBe("B");
    expect(s.entries[0]).toEqual({
      id: "A",
      title: "a.bnet",
      document,
      userFileURL: "file:///Users/me/My%20Nets/a.bnet",
      statusLog: [{ id: "L", date: toSwiftDate(Date.UTC(2026, 0, 1)), severity: "warning", text: "Careful" }],
    });
    expect(s.entries[1].userFileURL).toBeNull();
  });

  it("writes log dates as Foundation reference-date seconds and file URLs as URL.absoluteString did", () => {
    expect(toSwiftDate(Date.UTC(2001, 0, 1))).toBe(0);
    expect(fromSwiftDate(toSwiftDate(1_762_000_000_123))).toBe(1_762_000_000_123);
    expect(pathToFileUrl("/Users/me/Ünï nets/a b.bnet")).toBe("file:///Users/me/%C3%9Cn%C3%AF%20nets/a%20b.bnet");
    expect(fileUrlToPath("file:///Users/me/%C3%9Cn%C3%AF%20nets/a%20b.bnet")).toBe("/Users/me/Ünï nets/a b.bnet");
    expect(fileUrlToPath("https://example.com/a.bnet")).toBeNull();
  });
});

describe("restoring at launch (WS-136…140, FILE-055)", () => {
  const now = new Date(2026, 10, 11, 9, 30);

  it("brings back the tabs with their ids, titles, documents, files and logs, the saved one active, every one clean", () => {
    const document = docWith(3, { canvasScale: 0.5, canvasPanOffset: [-30, 7] });
    const ws = tabsFromSnapshot({ activeTabID: "B", entries: [entry("A", { document, statusLog: [{ id: "E", date: 0, severity: "error", text: "Run failed" }] }), entry("B")] }, now)!;
    expect(ws.activeId).toBe("B");
    expect(ws.tabs.map((t) => [t.id, t.title, t.path])).toEqual([["A", "A.bnet", "/Users/me/My Nets/A.bnet"], ["B", "B.bnet", "/Users/me/My Nets/B.bnet"]]);
    // CAN-133: scale and pan survive.
    expect(ws.tabs[0].document).toEqual(document);
    expect(ws.tabs.every((t) => !isDirty(t))).toBe(true);
    // WS-137: the log gets a session boundary; an empty log stays empty.
    expect(ws.tabs[0].log.map((e) => [e.severity, e.text])).toEqual([["error", "Run failed"], ["info", `──── New session — ${shortDateTime(now)} ────`]]);
    expect(ws.tabs[0].log[0].date).toBe(fromSwiftDate(0));
    expect(ws.tabs[1].log).toEqual([]);
  });

  it("writes the boundary with the short date and short time", () => {
    expect(shortDateTime(now)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(now));
  });

  it("selects the first tab when the saved active tab is missing", () => {
    expect(tabsFromSnapshot({ activeTabID: "gone", entries: [entry("A"), entry("B")] })!.activeId).toBe("A");
    expect(tabsFromSnapshot({ entries: [entry("A")] })!.activeId).toBe("A");
  });

  it("ignores a snapshot that is empty or isn't one (WS-140)", () => {
    for (const bad of [null, 3, "x", {}, { entries: [] }, { entries: [{ id: "A" }] }, { entries: [entry("A"), entry("A")] }]) expect(tabsFromSnapshot(bad)).toBeNull();
  });

  it("converts 0.90.34's legacy string log, its time put back on today and its severity guessed (FILE-055)", () => {
    const ws = tabsFromSnapshot({ entries: [entry("A", { statusLog: undefined, statusMessages: ["[2:05:09 PM] Saved network to a.bnet.", "Run aborted: no solver", "plain"] })] }, now)!;
    const log = ws.tabs[0].log;
    expect(log.map((e) => [e.severity, e.text])).toEqual([
      ["success", "Saved network to a.bnet."],
      ["error", "Run aborted: no solver"],
      ["info", "plain"],
      ["info", `──── New session — ${shortDateTime(now)} ────`],
    ]);
    expect(new Date(log[0].date)).toEqual(new Date(2026, 10, 11, 14, 5, 9));
    expect(legacyEntry("[14:05:09] x", now).date).toBe(new Date(2026, 10, 11, 14, 5, 9).getTime());
    expect(inferSeverity("No warnings — banner hidden.")).toBe("success");
    expect(inferSeverity("Analysis warning: unstable")).toBe("warning");
    expect(inferSeverity("⚠ Solver failed")).toBe("error");
  });

  it("replaces the launch tab with the saved session", async () => {
    backend({ session: { activeTabID: "B", entries: [entry("A"), entry("B")] } });
    await act(() => restoreSession());
    expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["A", "B"]);
    expect(getWorkspace().activeId).toBe("B");
  });

  it("falls back to the files in tabs.currentURLs, skipping missing ones, then to one Untitled tab", async () => {
    backend({ state: { [URLS_KEY]: ["file:///examples/tandem_line.bnet", "file:///nowhere/gone.bnet"] }, files: { "/examples/tandem_line.bnet": JSON.stringify(docWith(2)) } });
    await act(() => restoreSession());
    expect(getWorkspace().tabs.map((t) => [t.title, t.path])).toEqual([["tandem_line.bnet", "/examples/tandem_line.bnet"]]);
    resetSession();
    backend({});
    seed([tab("only", { nodes: 0 })]);
    await act(() => restoreSession());
    expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["only"]);
  });
});

describe("saving while the app runs (WS-127, WS-128, WS-130, WS-139, CAN-134)", () => {
  it("saves once, 400 ms after the last of a burst of edits", async () => {
    backend({});
    seed([tab("A"), tab("B")]);
    vi.useFakeTimers();
    const stop = startAutosave();
    setDocument("A", docWith(2));
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 50);
    setDocument("A", docWith(3));
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(mockSession.saves).toBe(0);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await waitFor(() => expect(mockSession.saves).toBe(1));
    expect((mockSession.snapshot as { entries: { document: { nodes: unknown[] } }[] }).entries[0].document.nodes).toHaveLength(3);
    stop();
  });

  it("counts tab additions, removals, moves, switches, zoom and pan, files and log lines, but not the saved mark alone", () => {
    seed([tab("A"), tab("B")]);
    const seen: boolean[] = [];
    const stop = (() => {
      let prev = getWorkspace();
      return () => {
        const next = getWorkspace();
        seen.push(changesSnapshot(next, prev));
        prev = next;
      };
    })();
    const step = (f: () => void) => {
      f();
      stop();
    };
    step(() => addTab());
    step(() => moveTab("A", 2));
    step(() => selectTab("B"));
    step(() => updateTab("A", { document: { ...getWorkspace().tabs.find((t) => t.id === "A")!.document, canvasScale: 3 } }));
    step(() => updateTab("A", { document: { ...getWorkspace().tabs.find((t) => t.id === "A")!.document, canvasPanOffset: [5, 5] } }));
    step(() => addStatus("hello", "info", "A"));
    step(() => markSaved("A", "/n/a.bnet", "a.bnet"));
    step(() => updateTab("B", { savedRevision: 99 }));
    expect(seen).toEqual([true, true, true, true, true, true, true, false]);
  });

  it("keeps tabs.currentURLs as the open files, in bar order", async () => {
    backend({});
    await loadKv();
    seed([tab("A"), tab("B")]);
    const stop = startAutosave();
    act(() => markSaved("B", "/n/b c.bnet", "b c.bnet"));
    act(() => markSaved("A", "/n/a.bnet", "a.bnet"));
    expect(getStateValue(URLS_KEY, null)).toEqual(["file:///n/a.bnet", "file:///n/b%20c.bnet"]);
    stop();
  });
});

describe("quitting (MENU-007, WS-132…135)", () => {
  beforeEach(() => {
    render(<DialogHost />);
  });

  it("with nothing on any canvas, clears the session and quits without asking", async () => {
    backend({ session: { entries: [entry("A")] }, state: { [URLS_KEY]: ["file:///n/a.bnet"] } });
    await loadKv();
    seed([tab("A", { path: "/n/a.bnet", nodes: 0 })]);
    expect(hasRestorableContent()).toBe(false);
    await act(() => quit());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockSession.snapshot).toBeNull();
    expect(getStateValue(URLS_KEY, null)).toBeNull();
    expect(quitCalls.count).toBe(1);
  });

  it("asks in 0.90.34's words; Restore Tabs saves the session now, unsaved changes and all, and quits", async () => {
    backend({});
    await loadKv();
    seed([tab("A", { dirty: true, nodes: 2 }), tab("B", { nodes: 0 })], "A");
    const done = quit();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Restore tabs on next launch?");
    expect(dialog).toHaveTextContent("Your current tabs can be reopened the next time Qnet starts. Change this later in Settings ▸ General.");
    expect(screen.getByRole("checkbox", { name: "Do not ask again" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Don't Restore" })).toBeInTheDocument();
    // WS-135: no question about the unsaved tab.
    await answer("Restore Tabs");
    await done;
    expect((mockSession.snapshot as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["A", "B"]);
    expect(getSetting("tabs.restoreBehavior", 0)).toBe(0);
    expect(quitCalls.count).toBe(1);
  });

  it("Don't Restore with Do not ask again clears the session and stores Never", async () => {
    backend({ session: { entries: [entry("A")] }, state: { [URLS_KEY]: ["file:///n/a.bnet"] } });
    await loadKv();
    seed([tab("A", { nodes: 1 })]);
    const done = quit();
    await answer("Don't Restore", "Restore tabs", { tick: true });
    await done;
    expect(mockSession.snapshot).toBeNull();
    expect(getStateValue(URLS_KEY, null)).toBeNull();
    expect(getSetting("tabs.restoreBehavior", 0)).toBe(2);
    expect(quitCalls.count).toBe(1);
  });

  it("Restore Tabs with Do not ask again stores Always", async () => {
    backend({});
    await loadKv();
    seed([tab("A", { nodes: 1 })]);
    const done = quit();
    await answer("Restore Tabs", undefined, { tick: true });
    await done;
    expect(getSetting("tabs.restoreBehavior", 0)).toBe(1);
  });

  it("Always saves without asking; Never clears without asking (WS-133)", async () => {
    backend({ settings: { "tabs.restoreBehavior": 1 } });
    await loadKv();
    seed([tab("A", { nodes: 1 })]);
    await act(() => quit());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((mockSession.snapshot as { entries: unknown[] }).entries).toHaveLength(1);

    resetSession();
    backend({ settings: { "tabs.restoreBehavior": 2 }, session: { entries: [entry("A")] } });
    const { resetKv } = await import("../../lib/kv");
    resetKv();
    await loadKv();
    await act(() => quit());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockSession.snapshot).toBeNull();
    expect(quitCalls.count).toBe(2);
  });

  it("no pending save brings a cleared session back (0.90.34 cancelPendingSave)", async () => {
    backend({ settings: { "tabs.restoreBehavior": 2 } });
    await loadKv();
    seed([tab("A", { nodes: 1 })]);
    const stop = startAutosave();
    act(() => setDocument("A", docWith(2)));
    await act(() => quit());
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 50));
    expect(mockSession.snapshot).toBeNull();
    expect(mockSession.saves).toBe(0);
    stop();
  });

  it("a crash leaves the last snapshot, so it comes back even with Never (WS-139)", async () => {
    backend({ settings: { "tabs.restoreBehavior": 2 } });
    await loadKv();
    seed([tab("A", { nodes: 1 })]);
    const stop = startAutosave();
    act(() => setDocument("A", docWith(2)));
    await waitFor(() => expect(mockSession.saves).toBe(1), { timeout: 2000 });
    stop();
    // The next launch, without a quit in between.
    const saved = mockSession.snapshot;
    resetSession();
    backend({ settings: { "tabs.restoreBehavior": 2 }, session: saved });
    seed([tab("fresh", { nodes: 0 })]);
    await act(() => restoreSession());
    expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["A"]);
  });
});
