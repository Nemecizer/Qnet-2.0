// The pieces every P4 area builds on: the workspace store, alerts, the menu description and the
// settings copy.
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { DialogHost } from "../components/DialogHost";
import { defaultHandlers } from "../dev/mockBackend";
import { registerCommands } from "../lib/commands";
import { saveChanges } from "../lib/dialogs";
import { loadKv, setSettings, useSetting } from "../lib/kv";
import { displayAccel, resolveMenu, shortcutFor, type MenuNode } from "../lib/menu";
import { MENU_SPEC, specCommandIds, type SpecEntry } from "../lib/menuSpec";
import { modalOpen } from "../lib/overlays";
import { addStatus, addTab, getWorkspace, isDirty, removeTabs, selectTab, setDocument } from "../workspace/store";
import { emptyDocument } from "../lib/bnet";
import { mockTauri } from "./tauri";

describe("the workspace store", () => {
  it("activates the nearest tab after a closed active one, else the one before, and never leaves none", () => {
    const a = getWorkspace().tabs[0].id;
    const b = addTab({ title: "b.bnet" });
    const c = addTab({ title: "c.bnet" });
    const d = addTab({ title: "d.bnet" });
    selectTab(b);
    removeTabs([b, c]);
    expect(getWorkspace().activeId).toBe(d);
    removeTabs([d]);
    expect(getWorkspace().activeId).toBe(a);
    removeTabs([a]);
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(getWorkspace().tabs[0]).toMatchObject({ title: "Untitled", path: null });
  });

  it("marks a tab dirty on an edit, keeps a log per tab, and gives tabs upper-case UUIDs", () => {
    const t = getWorkspace().tabs[0];
    expect(t.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(isDirty(t)).toBe(false);
    setDocument(t.id, { ...emptyDocument(), infiniteBuffers: true });
    expect(isDirty(getWorkspace().tabs[0])).toBe(true);
    const other = addTab({}, { activate: false });
    addStatus("Opened tandem.bnet.", "success");
    expect(getWorkspace().tabs[0].log.map((e) => [e.severity, e.text])).toEqual([["success", "Opened tandem.bnet."]]);
    expect(getWorkspace().tabs.find((x) => x.id === other)!.log).toEqual([]);
  });
});

describe("alerts", () => {
  it("asks the close guard's question with 0.90.34's words, and ⌘D answers Don’t Save", async () => {
    render(<DialogHost />);
    let answer: string | undefined;
    act(() => void saveChanges("tandem.bnet", true).then((a) => (answer = a)));
    expect(await screen.findByRole("alertdialog", { name: "Do you want to save the changes made to “tandem.bnet”?" })).toHaveTextContent("Your changes will be lost if you don’t save them.");
    expect(modalOpen()).toBe(true);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Don’t Save", "Cancel", "Save"]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true })));
    await waitFor(() => expect(answer).toBe("discard"));
    expect(modalOpen()).toBe(false);
  });

  it("cancels with Escape and offers Save… for a network never saved", async () => {
    render(<DialogHost />);
    let answer: string | undefined;
    act(() => void saveChanges("Untitled", false).then((a) => (answer = a)));
    expect(await screen.findByRole("button", { name: "Save…" })).toHaveFocus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await waitFor(() => expect(answer).toBe("cancel"));
  });
});

describe("the menu description", () => {
  const walk = (entries: SpecEntry[], out: { id: string; accel?: string }[] = []) => {
    for (const e of entries) {
      if (e === "-") continue;
      if ("id" in e) out.push(e);
      else if ("submenu" in e) walk(e.items, out);
    }
    return out;
  };

  it("names every command once and gives no two items the same shortcut", () => {
    const ids = specCommandIds();
    expect(new Set(ids).size).toBe(ids.length);
    const accels = walk(MENU_SPEC).filter((e) => e.accel).map((e) => e.accel!.toLowerCase());
    expect(accels.length - new Set(accels).size).toBe(0);
  });

  it("dims commands nobody registered and gives a buffer-mode pair's key to the enabled one", () => {
    const find = (nodes: MenuNode[], id: string): Extract<MenuNode, { type: "item" }> | undefined => {
      for (const n of nodes) {
        if (n.type === "item" && n.id === id) return n;
        if (n.type === "submenu") {
          const f = find(n.items, id);
          if (f) return f;
        }
      }
      return undefined;
    };
    expect(find(resolveMenu(), "run:monte-carlo-infinite")).toMatchObject({ enabled: false, accel: "CmdOrCtrl+Alt+M" });
    const stop = registerCommands([
      { id: "run:monte-carlo-infinite", title: "Run Monte Carlo…", group: "Run", when: () => "This network has finite buffers", run: () => {} },
      { id: "run:monte-carlo-finite", title: "Run Monte Carlo…", group: "Run", run: () => {} },
    ]);
    const m = resolveMenu();
    expect(find(m, "run:monte-carlo-infinite")).toMatchObject({ enabled: false });
    expect(find(m, "run:monte-carlo-infinite")?.accel).toBeUndefined();
    expect(find(m, "run:monte-carlo-finite")).toMatchObject({ enabled: true, accel: "CmdOrCtrl+Alt+M" });
    expect(shortcutFor("run:monte-carlo-finite")).toBe("⌥⌘M");
    stop();
  });

  it("reads shortcuts in the Mac's modifier order", () => {
    expect(displayAccel("CmdOrCtrl+Shift+T")).toBe("⇧⌘T");
    expect(displayAccel("Ctrl+CmdOrCtrl+Enter")).toBe("⌃⌘↩");
    expect(displayAccel("CmdOrCtrl+Alt+Shift+0")).toBe("⌥⇧⌘0");
  });
});

describe("settings", () => {
  function Probe() {
    return <span>{String(useSetting("status.paneVisible", "unset"))}</span>;
  }

  it("load with their defaults, follow a change made anywhere, and refuse a bad value", async () => {
    mockTauri(defaultHandlers({ settings: { "tabs.restoreBehavior": 2 } }));
    await loadKv();
    render(<Probe />);
    expect(screen.getByText("true")).toBeInTheDocument();
    await act(() => emit("kv://changed", { store: "settings", patch: { "status.paneVisible": false } }));
    expect(await screen.findByText("false")).toBeInTheDocument();
    await expect(setSettings({ "status.paneVisible": "no" })).rejects.toThrow("takes true or false");
  });
});
