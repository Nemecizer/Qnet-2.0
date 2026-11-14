// Closing tabs with their save guards, and Reopen Closed Tab (ledger 5.3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { getWorkspace, markSaved, isDirty, tabById } from "../store";
import { closeAllTabs, closedTabs, closeOtherTabs, closeTabs, closeTabsToTheRight, CLOSED_TAB_CAPACITY, mostRecentClosedTitle, reopenClosedTab, resetClosedTabs, showAdjacentTab } from "./closing";
import { answer, docWith, seed, tab } from "./testkit";

const save = vi.hoisted(() => ({ saveTab: vi.fn(async (_id: string, _o?: { saveAs?: boolean }) => true) }));
vi.mock("../files", () => ({ saveTab: save.saveTab, openPath: async () => false, useFileCommands: () => {}, FilesHost: () => null }));

const ids = () => getWorkspace().tabs.map((t) => t.id);

beforeEach(() => {
  render(<DialogHost />);
  save.saveTab.mockReset();
  save.saveTab.mockImplementation(async (id: string) => {
    const t = tabById(id)!;
    markSaved(id, t.path ?? `/nets/${t.title}.bnet`, t.path ? t.title : `${t.title}.bnet`);
    return true;
  });
});
afterEach(() => resetClosedTabs());

describe("the guarded close (WS-036, WS-039…042, WS-044)", () => {
  it("closes a clean tab without asking and activates the tab after it, else the one before", async () => {
    seed([tab("A"), tab("B"), tab("C")], "B");
    await act(() => closeTabs(["B"]));
    expect(ids()).toEqual(["A", "C"]);
    expect(getWorkspace().activeId).toBe("C");
    await act(() => closeTabs(["C"]));
    expect(getWorkspace().activeId).toBe("A");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("leaves one new Untitled tab after the last close", async () => {
    seed([tab("A")]);
    await act(() => closeTabs(["A"]));
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(getWorkspace().tabs[0]).toMatchObject({ title: "Untitled", path: null });
    expect(getWorkspace().tabs[0].id).not.toBe("A");
  });

  it("asks about a dirty file-backed tab in 0.90.34's words, and Don't Save closes it", async () => {
    seed([tab("A", { path: "/n/tandem.bnet", dirty: true }), tab("B")]);
    const done = closeTabs(["A"]);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Do you want to save the changes made to “tandem.bnet”?");
    expect(dialog).toHaveTextContent("Your changes will be lost if you don’t save them.");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    await answer("Don’t Save");
    expect(await done).toBe(true);
    expect(ids()).toEqual(["B"]);
    expect(save.saveTab).not.toHaveBeenCalled();
  });

  it("offers Save… for an untitled tab; Save saves it, renamed, and then closes", async () => {
    seed([tab("A", { dirty: true }), tab("B")]);
    const done = closeTabs(["A"]);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("This network has never been saved. Your changes will be lost if you don’t save them; Save asks where to put the .bnet file.");
    await answer("Save…");
    expect(await done).toBe(true);
    expect(save.saveTab).toHaveBeenCalledWith("A");
    expect(ids()).toEqual(["B"]);
    // What Reopen brings back is the saved tab: renamed, with its file, clean.
    expect(closedTabs()[0]).toMatchObject({ title: "Untitled.bnet", path: "/nets/Untitled.bnet", wasClean: true });
  });

  it("a cancelled Save panel cancels the whole close", async () => {
    save.saveTab.mockImplementation(async () => false);
    seed([tab("A", { dirty: true }), tab("B", { dirty: true })]);
    const done = closeTabs(["A", "B"]);
    await answer("Save…");
    expect(await done).toBe(false);
    expect(ids()).toEqual(["A", "B"]);
    expect(closedTabs()).toHaveLength(0);
  });

  it("asks about each dirty tab in tab-bar order; Cancel on the second cancels everything", async () => {
    seed([tab("A", { title: "one", dirty: true }), tab("B"), tab("C", { title: "three", dirty: true })]);
    const done = closeTabs(["C", "B", "A"]);
    await answer("Don’t Save", "“one”");
    await answer("Cancel", "“three”");
    expect(await done).toBe(false);
    expect(ids()).toEqual(["A", "B", "C"]);
  });

  it("Close Other Tabs and Close Tabs to the Right pick their sets, and do nothing when empty (WS-038)", async () => {
    seed([tab("A"), tab("B"), tab("C"), tab("D")], "B");
    expect(await closeTabsToTheRight("D")).toBe(false);
    await act(() => closeTabsToTheRight("B"));
    expect(ids()).toEqual(["A", "B"]);
    await act(() => closeOtherTabs("A"));
    expect(ids()).toEqual(["A"]);
    expect(await closeOtherTabs("A")).toBe(false);
  });

  it("Close All Tabs asks about every dirty tab, then leaves one Untitled tab", async () => {
    seed([tab("A", { dirty: true }), tab("B", { dirty: true })]);
    const done = closeAllTabs();
    await answer("Don’t Save");
    await answer("Don’t Save");
    expect(await done).toBe(true);
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(getWorkspace().tabs[0].title).toBe("Untitled");
  });
});

describe("Reopen Closed Tab (WS-045…048, MENU-145)", () => {
  it("keeps at most ten closed tabs, newest on top, and not a blank Untitled one", async () => {
    seed([tab("blank", { nodes: 0 }), ...Array.from({ length: 12 }, (_, i) => tab(`T${i}`, { title: `t${i}` }))]);
    await act(() => closeTabs(["blank"]));
    expect(closedTabs()).toHaveLength(0);
    for (let i = 0; i < 12; i++) await act(() => closeTabs([`T${i}`]));
    expect(closedTabs()).toHaveLength(CLOSED_TAB_CAPACITY);
    expect(closedTabs()[0].title).toBe("t2");
    expect(mostRecentClosedTitle()).toBe("t11");
  });

  it("keeps an empty tab that has a file", async () => {
    seed([tab("A", { path: "/n/empty.bnet", nodes: 0 }), tab("B")]);
    await act(() => closeTabs(["A"]));
    expect(mostRecentClosedTitle()).toBe("empty.bnet");
  });

  it("brings the last closed tab back at the end, selected, with its document, file, log and id", async () => {
    const log = [{ id: "L1", date: 1, severity: "info" as const, text: "Loaded network with 1 node." }];
    const document = docWith(2, { canvasScale: 1.5, canvasPanOffset: [40, -12] });
    seed([tab("A", { path: "/n/a.bnet", log, document }), tab("B"), tab("C")], "B");
    await act(() => closeTabs(["A"]));
    let id: string | null = null;
    act(() => {
      id = reopenClosedTab();
    });
    expect(id).toBe("A");
    expect(ids()).toEqual(["B", "C", "A"]);
    expect(getWorkspace().activeId).toBe("A");
    const t = tabById("A")!;
    expect(t).toMatchObject({ title: "a.bnet", path: "/n/a.bnet" });
    // CAN-133: scale and pan come back.
    expect(t.document).toEqual(document);
    expect(isDirty(t)).toBe(false);
    expect(t.log.map((e) => e.text)).toEqual(["Loaded network with 1 node.", "Reopened a.bnet."]);
    expect(closedTabs()).toHaveLength(0);
    expect(reopenClosedTab()).toBeNull();
  });

  it("a tab closed with Don't Save comes back dirty, and says so", async () => {
    seed([tab("A", { title: "rework", dirty: true }), tab("B")]);
    const done = closeTabs(["A"]);
    await answer("Don’t Save");
    await done;
    act(() => void reopenClosedTab());
    const t = tabById("A")!;
    expect(isDirty(t)).toBe(true);
    expect(t.log.at(-1)?.text).toBe("Reopened rework with its unsaved changes.");
  });
});

describe("next and previous tab (WS-028)", () => {
  it("wraps round at both ends and does nothing with one tab", () => {
    seed([tab("A"), tab("B"), tab("C")], "C");
    act(() => showAdjacentTab(1));
    expect(getWorkspace().activeId).toBe("A");
    act(() => showAdjacentTab(-1));
    expect(getWorkspace().activeId).toBe("C");
    seed([tab("Z")]);
    act(() => showAdjacentTab(1));
    expect(getWorkspace().activeId).toBe("Z");
  });
});
