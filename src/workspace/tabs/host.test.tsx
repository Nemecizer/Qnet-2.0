// The tab commands and the Window menu's tab items, the window title, ⌃⇥, the launch host, and the
// window frame (ledger 5.1, 5.3, 5.10, MENU-007, MENU-015…017, MENU-142…145, KEY-002, INV-021).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockOpenedFiles, quitCalls } from "../../dev/mock/core";
import { mockSession } from "../../dev/mock/session";
import { getCommand, runCommand, unavailableReason } from "../../lib/commands";
import { loadKv } from "../../lib/kv";
import { resolveMenu, type MenuNode } from "../../lib/menu";
import { holdModal } from "../../lib/overlays";
import { emitMock, mockCalls, mockTauri, type MockHandlers } from "../../test/tauri";
import { getWorkspace, markSaved, selectTab, setDocument } from "../store";
import { closedTabs, resetClosedTabs } from "./closing";
import { clampFrame, DEGENERATE_SIDE, FRAME_KEY, formatRect, parseRect, restoreFrame, saveFrame } from "./frame";
import { onTabSwitchKey, resetTabsHost, TabsHost, useTabCommands, WindowTitle } from "./index";
import { resetSession } from "./session";
import { abbreviateWithTilde, folderOf, setHome } from "./title";
import { answer, docWith, seed, tab } from "./testkit";

const aux = vi.hoisted(() => ({ focused: null as null | { name: string; close: () => void } }));
vi.mock("../../lib/auxWindow", async (orig) => ({ ...(await orig<object>()), focusedAuxWindow: () => aux.focused ?? undefined }));
vi.mock("../files", () => ({ saveTab: async () => true, openPath: async () => false, useFileCommands: () => {}, FilesHost: () => null }));

function Commands() {
  useTabCommands();
  return null;
}

function items(nodes: MenuNode[] = resolveMenu()): Extract<MenuNode, { type: "item" }>[] {
  const out: Extract<MenuNode, { type: "item" }>[] = [];
  const walk = (n: MenuNode[]) => n.forEach((x) => (x.type === "item" ? out.push(x) : x.type === "submenu" ? walk(x.items) : undefined));
  walk(nodes);
  return out;
}
const item = (id: string) => items().find((i) => i.id === id);
const calls = (cmd: string) => mockCalls.filter((c) => c.cmd === cmd);

function backend(opts: Parameters<typeof defaultHandlers>[0] & { session?: unknown } = {}, extra: MockHandlers = {}) {
  mockTauri({ ...defaultHandlers(opts), ...extra });
}

beforeEach(() => {
  resetSession();
  resetTabsHost();
  aux.focused = null;
  quitCalls.count = 0;
  backend();
  render(<DialogHost />);
});
afterEach(() => {
  resetClosedTabs();
  resetSession();
  setHome(null);
});

describe("the File menu's close items (MENU-015…017, WS-037, WS-049, INV-021)", () => {
  it("⌘W closes the active tab when the main window has the keyboard", async () => {
    seed([tab("A"), tab("B")], "B");
    render(<Commands />);
    await act(() => runCommand("file:close-tab"));
    expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["A"]);
    expect(getCommand("file:close-tab")?.subtitle).toBe("Close the front tab (asks to save unsaved changes first), or the front auxiliary window");
  });

  it("⌘W and ⇧⌘W close the front auxiliary window instead when one has the keyboard", async () => {
    const close = vi.fn();
    aux.focused = { name: "settings", close };
    seed([tab("A"), tab("B")]);
    render(<Commands />);
    await act(() => runCommand("file:close-tab"));
    await act(() => runCommand("file:close-window"));
    expect(close).toHaveBeenCalledTimes(2);
    expect(getWorkspace().tabs).toHaveLength(2);
    expect(calls("plugin:window|hide")).toHaveLength(0);
  });

  it("⇧⌘W closes the main window with no unsaved-changes check; the tabs stay for when it comes back", async () => {
    seed([tab("A", { dirty: true })]);
    render(<Commands />);
    await act(() => runCommand("file:close-window"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls("plugin:window|hide")).toHaveLength(1);
    expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["A"]);
    // The Window menu's tab items bring it back.
    act(() => void items().find((i) => i.id === "window:tab-1"));
    const { runMenuItem } = await import("../../lib/menu");
    await act(async () => runMenuItem("window:tab-1"));
    await waitFor(() => expect(calls("plugin:window|show")).toHaveLength(1));
  });

  it("⌥⌘W closes every tab with the guard", async () => {
    seed([tab("A", { dirty: true, title: "one" }), tab("B")]);
    render(<Commands />);
    const done = runCommand("file:close-all-tabs");
    await answer("Don’t Save", "“one”");
    await act(() => done);
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(closedTabs().map((t) => t.id)).toEqual(["A", "B"]);
  });

  it("the closes wait while a dialog is up", () => {
    render(<Commands />);
    const release = holdModal();
    for (const id of ["file:close-tab", "file:close-all-tabs", "file:close-window"]) expect(unavailableReason(getCommand(id)!)).toBe("Close the open dialog first");
    release();
    expect(unavailableReason(getCommand("file:close-tab")!)).toBeNull();
  });

  it("there is no New Window (WS-006)", () => {
    render(<Commands />);
    expect(items().some((i) => /new window/i.test(i.label))).toBe(false);
  });
});

describe("the Window menu's tab items (MENU-142…145, WS-028…030, WS-046)", () => {
  it("lists the first nine tabs by title with ⌘1–⌘9, the active one checked, and choosing one shows it", async () => {
    seed(Array.from({ length: 11 }, (_, i) => tab(`T${i}`, { title: `net ${i}` })), "T2");
    render(<Commands />);
    const list = items().filter((i) => i.id.startsWith("window:tab-"));
    expect(list.map((i) => [i.label, i.accel, i.checked])).toEqual(Array.from({ length: 9 }, (_, i) => [`net ${i}`, `CmdOrCtrl+${i + 1}`, i === 2]));
    const { runMenuItem } = await import("../../lib/menu");
    act(() => runMenuItem("window:tab-5"));
    expect(getWorkspace().activeId).toBe("T4");
    // In the menu between the tab-switch items and Reopen Closed Tab.
    const ids = items().map((i) => i.id);
    expect(ids.indexOf("window:previous-tab")).toBeLessThan(ids.indexOf("window:tab-1"));
    expect(ids.indexOf("window:tab-9")).toBeLessThan(ids.indexOf("window:reopen-tab"));
  });

  it("Show Next / Previous Tab wrap round, and are dimmed with one tab or while a dialog is up", async () => {
    seed([tab("A"), tab("B")], "B");
    render(<Commands />);
    expect(item("window:next-tab")).toMatchObject({ label: "Show Next Tab", accel: "CmdOrCtrl+Shift+]", enabled: true });
    await act(() => runCommand("window:next-tab"));
    expect(getWorkspace().activeId).toBe("A");
    await act(() => runCommand("window:previous-tab"));
    expect(getWorkspace().activeId).toBe("B");
    const release = holdModal();
    expect(item("window:next-tab")?.enabled).toBe(false);
    expect(item("window:previous-tab")?.enabled).toBe(false);
    expect(items().filter((i) => i.id.startsWith("window:tab-")).every((i) => i.enabled === false)).toBe(true);
    release();
    seed([tab("A")]);
    expect(item("window:next-tab")?.enabled).toBe(false);
    expect(unavailableReason(getCommand("window:next-tab")!)).toBe("Only one tab is open");
  });

  it("Reopen Closed Tab is dimmed until a tab closes, and its tooltip names the tab", async () => {
    seed([tab("A", { title: "tandem.bnet" }), tab("B")]);
    render(<Commands />);
    expect(item("window:reopen-tab")?.enabled).toBe(false);
    expect(getCommand("window:reopen-tab")?.subtitle).toBe("No tab has been closed in this session");
    await act(() => runCommand("file:close-tab"));
    await waitFor(() => expect(item("window:reopen-tab")?.enabled).toBe(true));
    expect(getCommand("window:reopen-tab")?.subtitle).toBe("Bring back “tandem.bnet”, the last tab closed");
    await act(() => runCommand("window:reopen-tab"));
    expect(getWorkspace().tabs.map((t) => t.title)).toEqual(["Untitled", "tandem.bnet"]);
    expect(getWorkspace().activeId).toBe("A");
    await waitFor(() => expect(item("window:reopen-tab")?.enabled).toBe(false));
  });

  it("⌃⇥ and ⌃⇧⇥ show the next and previous tab, not while a dialog is up", () => {
    seed([tab("A"), tab("B"), tab("C")], "A");
    render(<TabsHost />);
    fireEvent.keyDown(window, { code: "Tab", key: "Tab", ctrlKey: true });
    expect(getWorkspace().activeId).toBe("B");
    fireEvent.keyDown(window, { code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true });
    expect(getWorkspace().activeId).toBe("C");
    fireEvent.keyDown(window, { code: "Tab", key: "Tab", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(window, { code: "Tab", key: "Tab" });
    expect(getWorkspace().activeId).toBe("C");
    const release = holdModal();
    const e = new KeyboardEvent("keydown", { code: "Tab", key: "Tab", ctrlKey: true, cancelable: true });
    onTabSwitchKey(e);
    expect(e.defaultPrevented).toBe(false);
    expect(getWorkspace().activeId).toBe("C");
    release();
  });
});

describe("the window title (WS-003, WS-004, TB-014)", () => {
  it("abbreviates the home folder with ~ and names the file's folder", () => {
    expect(abbreviateWithTilde("/Users/me/nets", "/Users/me")).toBe("~/nets");
    expect(abbreviateWithTilde("/Users/me", "/Users/me")).toBe("~");
    expect(abbreviateWithTilde("/Users/meg/nets", "/Users/me")).toBe("/Users/meg/nets");
    expect(folderOf("/Users/me/nets/a.bnet")).toBe("/Users/me/nets");
    expect(folderOf("/a.bnet")).toBe("/");
  });

  it("shows the active tab's title, with its folder or Unsaved network, and sets the native title and edited dot", async () => {
    backend({}, { "plugin:path|resolve_directory": () => "/Users/me" });
    seed([tab("A", { path: "/Users/me/nets/tandem.bnet" }), tab("B")]);
    render(<><WindowTitle /><TabsHost /></>);
    expect(screen.getByText("tandem.bnet")).toBeInTheDocument();
    expect(await screen.findByText("~/nets")).toBeInTheDocument();
    await waitFor(() => expect(calls("plugin:window|set_title").at(-1)?.args).toMatchObject({ value: "tandem.bnet" }));
    expect(mockSession.documentState).toEqual({ path: "/Users/me/nets/tandem.bnet", edited: false });
    act(() => selectTab("B"));
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(screen.getByText("Unsaved network")).toBeInTheDocument();
    act(() => setDocument("B", docWith(2)));
    await waitFor(() => expect(mockSession.documentState).toEqual({ path: null, edited: true }));
    await waitFor(() => expect(calls("plugin:window|set_title").at(-1)?.args).toMatchObject({ value: "Untitled" }));
    act(() => markSaved("B", "/Users/me/b.bnet", "b.bnet"));
    expect(screen.getByText("~")).toBeInTheDocument();
    await waitFor(() => expect(mockSession.documentState).toEqual({ path: "/Users/me/b.bnet", edited: false }));
  });
});

describe("the launch host (WS-007, WS-136, MENU-007)", () => {
  it("restores the session, makes the window key, then saves changes", async () => {
    backend({ session: { activeTabID: "B", entries: [{ id: "A", title: "a.bnet", document: docWith(1), userFileURL: null, statusLog: [] }, { id: "B", title: "b.bnet", document: docWith(1), userFileURL: null, statusLog: [] }] } });
    render(<TabsHost />);
    await waitFor(() => expect(getWorkspace().tabs.map((t) => t.id)).toEqual(["A", "B"]));
    expect(getWorkspace().activeId).toBe("B");
    expect(calls("plugin:window|set_focus").length).toBeGreaterThan(0);
    act(() => setDocument("A", docWith(4)));
    await waitFor(() => expect(mockSession.saves).toBe(1), { timeout: 2000 });
  });

  it("opens a .bnet sent by Finder as File ▸ Open would, at launch and while running, and never twice (WS-124)", async () => {
    mockOpenedFiles.push("/examples/2dtandem.bnet");
    render(<><Commands /><TabsHost /></>);
    await waitFor(() => expect(getWorkspace().tabs.map((t) => t.path)).toEqual(["/examples/2dtandem.bnet"]));
    mockOpenedFiles.push("/examples/5stationtandem.inf.bnet", "/examples/2dtandem.bnet");
    await act(async () => {
      await emitMock("app://open-files", null);
    });
    await waitFor(() => expect(getWorkspace().tabs.map((t) => t.title)).toEqual(["2dtandem.bnet", "5stationtandem.inf.bnet"]));
    // The file that was already open came to the front instead of opening again.
    await waitFor(() => expect(getWorkspace().tabs.find((t) => t.id === getWorkspace().activeId)!.title).toBe("2dtandem.bnet"));
  });

  it("a file Finder sends that can't be opened doesn't stop the next one, and files wait under a dialog (the P8 review)", async () => {
    render(<><Commands /><TabsHost /></>);
    await waitFor(() => expect(getWorkspace().tabs).toHaveLength(1));
    mockOpenedFiles.push("/nowhere/missing.bnet");
    await act(async () => {
      await emitMock("app://open-files", null);
    });
    await answer("OK", "Load Failed");
    const release = holdModal();
    mockOpenedFiles.push("/examples/2dtandem.bnet");
    await act(async () => {
      await emitMock("app://open-files", null);
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(getWorkspace().tabs.map((t) => t.path)).toEqual([null]);
    release();
    await waitFor(() => expect(getWorkspace().tabs.map((t) => t.path)).toEqual(["/examples/2dtandem.bnet"]), { timeout: 3000 });
  });

  it("a quit from the Dock asks the same question as ⌘Q, showing the closed window first", async () => {
    seed([tab("A", { nodes: 1 })]);
    render(<><Commands /><TabsHost /></>);
    await act(() => runCommand("file:close-window"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await emitMock("app://quit-requested", null);
    });
    await answer("Restore Tabs", "Restore tabs on next launch?");
    await waitFor(() => expect(quitCalls.count).toBe(1));
    expect(calls("plugin:window|show")).toHaveLength(1);
    // ⌘Q runs it too.
    await act(async () => void runCommand("app:quit"));
    await answer("Don't Restore");
    await waitFor(() => expect(quitCalls.count).toBe(2));
  });
});

describe("the window frame (WS-141, WS-142)", () => {
  const screens = [{ x: 0, y: 25, w: 1440, h: 875 }, { x: 1440, y: 0, w: 1920, h: 1080 }];

  it("is stored in NSStringFromRect's form", () => {
    expect(formatRect({ x: 10, y: 20.5, w: 1200, h: 800 })).toBe("{{10, 20.5}, {1200, 800}}");
    expect(parseRect("{{10, 20.5}, {1200, 800}}")).toEqual({ x: 10, y: 20.5, w: 1200, h: 800 });
    expect(parseRect("{{-1440, 0}, {800, 600}}")).toEqual({ x: -1440, y: 0, w: 800, h: 600 });
    expect(parseRect("nonsense")).toBeNull();
  });

  it("is clamped onto the one screen it overlaps most, or the main screen when it overlaps none", () => {
    // Mostly on the second screen, hanging off its right edge.
    expect(clampFrame({ x: 3000, y: 100, w: 800, h: 600 }, screens, screens[0])).toEqual({ x: 2560, y: 100, w: 800, h: 600 });
    // On a display that is gone: the main screen, shrunk to fit.
    expect(clampFrame({ x: -5000, y: 100, w: 2000, h: 600 }, screens, screens[0])).toEqual({ x: 0, y: 100, w: 1440, h: 600 });
    // Straddling: pulled onto the one it mostly covers.
    expect(clampFrame({ x: 1000, y: 30, w: 800, h: 600 }, screens, screens[0])).toEqual({ x: 640, y: 30, w: 800, h: 600 });
    expect(clampFrame({ x: 1300, y: 30, w: 800, h: 600 }, screens, screens[0])).toEqual({ x: 1440, y: 30, w: 800, h: 600 });
  });

  const monitor = (x: number, y: number, w: number, h: number, scaleFactor = 2) => ({
    name: "m", scaleFactor, position: { x, y }, size: { width: w, height: h }, workArea: { position: { x, y }, size: { width: w, height: h } },
  });

  it("is restored at launch, clamped; a degenerate one is neither restored nor saved", async () => {
    const win: MockHandlers = {
      "plugin:window|available_monitors": () => [monitor(0, 0, 2880, 1800)],
      "plugin:window|primary_monitor": () => monitor(0, 0, 2880, 1800),
      "plugin:window|scale_factor": () => 2,
      "plugin:window|outer_position": () => ({ x: 200, y: 100 }),
      "plugin:window|outer_size": () => ({ width: 2400, height: 300 }),
    };
    backend({ state: { [FRAME_KEY]: "{{1000, 100}, {1000, 700}}" } }, win);
    await loadKv();
    await restoreFrame();
    const size = calls("plugin:window|set_size").at(-1)?.args.value;
    const pos = calls("plugin:window|set_position").at(-1)?.args.value;
    expect(JSON.parse(JSON.stringify(size))).toEqual({ Logical: { width: 1000, height: 700 } });
    expect(JSON.parse(JSON.stringify(pos))).toEqual({ Logical: { x: 440, y: 100 } });
    // 2400×300 physical at 2× is 1200×150 points: too short to save.
    await saveFrame();
    const { getStateValue } = await import("../../lib/kv");
    expect(getStateValue(FRAME_KEY, null)).toBe("{{1000, 100}, {1000, 700}}");
    expect(DEGENERATE_SIDE).toBe(200);

    backend({ state: { [FRAME_KEY]: "{{0, 0}, {150, 700}}" } }, win);
    const { resetKv } = await import("../../lib/kv");
    resetKv();
    await loadKv();
    await restoreFrame();
    expect(calls("plugin:window|set_size")).toHaveLength(0);
  });

  it("saves a usable frame in points", async () => {
    backend({}, { "plugin:window|scale_factor": () => 2, "plugin:window|outer_position": () => ({ x: 200, y: 100 }), "plugin:window|outer_size": () => ({ width: 2400, height: 1600 }) });
    await loadKv();
    await saveFrame();
    const { getStateValue } = await import("../../lib/kv");
    expect(getStateValue(FRAME_KEY, null)).toBe("{{100, 50}, {1200, 800}}");
  });
});
