// The tab bar (ledger 5.2): what each tab shows, its tooltips, the close slot, clicks, the context
// menu, drag to reorder, the overflow arrows and the + button.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { mockCalls } from "../../test/tauri";
import { getWorkspace, selectTab } from "../store";
import { closedTabs, resetClosedTabs } from "./closing";
import { middleTruncate, TabBar, TAB_MAX_TITLE_WIDTH } from "./TabBar";
import { answer, seed, tab } from "./testkit";

vi.mock("../files", () => ({ saveTab: async () => true, openPath: async () => false, useFileCommands: () => {}, FilesHost: () => null }));

const tabEl = (title: string) => screen.getByRole("tab", { name: new RegExp(`^${title}`) });
const order = () => getWorkspace().tabs.map((t) => t.id);

beforeEach(() => {
  render(<DialogHost />);
});
afterEach(() => {
  resetClosedTabs();
  vi.restoreAllMocks();
});

describe("tabs (WS-017…021, WS-031)", () => {
  it("shows every open network, the active one selected, in a bar named Open networks", () => {
    seed([tab("A", { title: "Untitled" }), tab("B", { path: "/Users/me/nets/tandem.bnet" }), tab("C", { title: "Untitled" })], "B");
    render(<TabBar />);
    const list = screen.getByRole("tablist", { name: "Open networks" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Untitled", "tandem.bnet", "Untitled"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs[1]).toHaveClass("is-active");
  });

  it("has the full path, or Unsaved network, as its tooltip", () => {
    seed([tab("A"), tab("B", { path: "/Users/me/nets/tandem.bnet" })]);
    render(<TabBar />);
    expect(tabEl("Untitled")).toHaveAttribute("title", "Unsaved network");
    expect(tabEl("tandem.bnet")).toHaveAttribute("title", "/Users/me/nets/tandem.bnet");
  });

  it("middle-truncates a long title to 220 pt", () => {
    const measure = (s: string) => s.length * 10;
    const long = "a-very-long-network-name-that-goes-on-and-on.bnet";
    const out = middleTruncate(long, TAB_MAX_TITLE_WIDTH, measure);
    expect(out.length * 10).toBeLessThanOrEqual(TAB_MAX_TITLE_WIDTH);
    expect(out).toMatch(/^a-very-lon.*….*on\.bnet$/);
    expect(middleTruncate("short.bnet", TAB_MAX_TITLE_WIDTH, measure)).toBe("short.bnet");
  });

  it("shows the unsaved dot in the close slot, and the ✕ instead while the pointer is over the tab, with 0.90.34's tooltips", () => {
    seed([tab("A", { title: "dirty", dirty: true }), tab("B", { title: "clean" })]);
    render(<TabBar />);
    const dirty = tabEl("dirty");
    expect(dirty).toHaveAccessibleName("dirty, edited");
    expect(within(dirty).getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(within(dirty).queryByRole("button")).toBeNull();
    fireEvent.mouseEnter(dirty);
    expect(within(dirty).queryByRole("img")).toBeNull();
    expect(within(dirty).getByRole("button", { name: "Close dirty" })).toHaveAttribute("title", "Close tab — asks to save its unsaved changes first (⌘W)");
    const clean = tabEl("clean");
    expect(within(clean).queryByRole("img")).toBeNull();
    fireEvent.mouseEnter(clean);
    expect(within(clean).getByRole("button", { name: "Close clean" })).toHaveAttribute("title", "Close tab (⌘W); ⇧⌘T brings it back");
    fireEvent.mouseLeave(clean);
    expect(within(clean).queryByRole("button")).toBeNull();
  });

  it("a click selects; the ✕ and a middle click close through the guard", async () => {
    seed([tab("A", { title: "one" }), tab("B", { title: "two", dirty: true }), tab("C", { title: "three" })]);
    render(<TabBar />);
    fireEvent.pointerDown(tabEl("three"), { button: 0, clientX: 5 });
    fireEvent.pointerUp(tabEl("three"), { button: 0, clientX: 5 });
    expect(getWorkspace().activeId).toBe("C");
    fireEvent.mouseEnter(tabEl("one"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close one" })));
    expect(order()).toEqual(["B", "C"]);
    fireEvent.pointerDown(tabEl("two"), { button: 1 });
    await answer("Don’t Save", "“two”");
    expect(order()).toEqual(["C"]);
    expect(closedTabs().map((t) => t.title)).toEqual(["one", "two"]);
  });
});

describe("the context menu (WS-022)", () => {
  it("has the three closes and Reveal in Finder, which is dimmed without a file", async () => {
    seed([tab("A", { title: "one" }), tab("B", { title: "two" }), tab("C", { path: "/n/three.bnet" })]);
    render(<TabBar />);
    fireEvent.contextMenu(tabEl("two"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Close Tab", "Close Other Tabs", "Close Tabs to the Right", "Reveal in Finder"]);
    expect(within(menu).getByRole("menuitem", { name: "Reveal in Finder" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Close Tabs to the Right" })));
    expect(order()).toEqual(["A", "B"]);
    fireEvent.contextMenu(tabEl("one"));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Close Other Tabs" })));
    expect(order()).toEqual(["A"]);
  });

  it("Reveal in Finder shows the tab's file", async () => {
    seed([tab("A", { path: "/n/three.bnet" })]);
    render(<TabBar />);
    fireEvent.contextMenu(tabEl("three.bnet"));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" })));
    const call = mockCalls.find((c) => c.cmd === "plugin:opener|reveal_item_in_dir");
    expect(call?.args).toMatchObject({ paths: ["/n/three.bnet"] });
  });

  it("Escape closes it", () => {
    seed([tab("A")]);
    render(<TabBar />);
    fireEvent.contextMenu(tabEl("Untitled"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("dragging a tab (WS-023, WS-024)", () => {
  function layout() {
    // Each tab 100 px wide, in bar order.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset?.tabId;
      const i = id ? order().indexOf(id) : -1;
      return i < 0 ? new DOMRect() : new DOMRect(i * 100, 0, 100, 28);
    });
  }

  it("lands the tab immediately before the one it was dropped on, marking it meanwhile; the active tab stays active", () => {
    seed([tab("A", { title: "a" }), tab("B", { title: "b" }), tab("C", { title: "c" }), tab("D", { title: "d" })], "B");
    render(<TabBar />);
    layout();
    const a = tabEl("a");
    fireEvent.pointerDown(a, { button: 0, clientX: 10 });
    fireEvent.pointerMove(a, { clientX: 250 });
    expect(tabEl("c")).toHaveClass("is-drop-target");
    expect(a).toHaveClass("is-dragging");
    fireEvent.pointerUp(a, { button: 0, clientX: 250 });
    expect(order()).toEqual(["B", "A", "C", "D"]);
    expect(getWorkspace().activeId).toBe("B");
    // Backwards: D onto B lands before B.
    const d = tabEl("d");
    fireEvent.pointerDown(d, { button: 0, clientX: 350 });
    fireEvent.pointerMove(d, { clientX: 20 });
    fireEvent.pointerUp(d, { button: 0, clientX: 20 });
    expect(order()).toEqual(["D", "B", "A", "C"]);
  });

  it("past the last tab moves it to the end; a small wobble is a click, not a drag", () => {
    seed([tab("A", { title: "a" }), tab("B", { title: "b" }), tab("C", { title: "c" })], "C");
    render(<TabBar />);
    layout();
    const a = tabEl("a");
    fireEvent.pointerDown(a, { button: 0, clientX: 10 });
    fireEvent.pointerMove(a, { clientX: 340 });
    expect(document.querySelector(".tabbar-end")).toHaveClass("is-drop-target");
    fireEvent.pointerUp(a, { button: 0, clientX: 340 });
    expect(order()).toEqual(["B", "C", "A"]);
    const b = tabEl("b");
    fireEvent.pointerDown(b, { button: 0, clientX: 10 });
    fireEvent.pointerMove(b, { clientX: 12 });
    fireEvent.pointerUp(b, { button: 0, clientX: 12 });
    expect(order()).toEqual(["B", "C", "A"]);
    expect(getWorkspace().activeId).toBe("B");
  });

  it("uses no HTML drag and drop, so nothing from outside can be dropped and a tab carries nothing out", () => {
    seed([tab("A"), tab("B")]);
    const { container } = render(<TabBar />);
    expect(container.querySelectorAll("[draggable=true]")).toHaveLength(0);
    const strip = screen.getByRole("tablist");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    strip.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(order()).toEqual(["A", "B"]);
  });
});

describe("the arrows, scrolling and the + button (WS-025…027)", () => {
  function sizes(scroll: number, client: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("tabbar-strip") ? scroll : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("tabbar-strip") ? client : 0;
    });
  }

  it("keeps the arrows' room but hides and disables them while the tabs fit", () => {
    sizes(300, 600);
    seed([tab("A"), tab("B")]);
    render(<TabBar />);
    const [prev, next] = [...document.querySelectorAll<HTMLButtonElement>(".tabbar-arrow")];
    expect(prev).toHaveAttribute("aria-label", "Previous Tab");
    expect(prev).toHaveClass("is-hidden");
    expect(prev).toBeDisabled();
    expect(prev).toHaveAttribute("title", "Previous Tab (⇧⌘[)");
    expect(next).toHaveAttribute("title", "Next Tab (⇧⌘])");
    expect(next).toBeDisabled();
  });

  it("shows them when the tabs overflow; they step through the tabs; disabled with one tab", () => {
    sizes(1200, 600);
    seed([tab("A"), tab("B"), tab("C")], "A");
    render(<TabBar />);
    const next = screen.getByRole("button", { name: "Next Tab" });
    expect(next).not.toHaveClass("is-hidden");
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(getWorkspace().activeId).toBe("B");
    fireEvent.click(screen.getByRole("button", { name: "Previous Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous Tab" }));
    expect(getWorkspace().activeId).toBe("C");
    seed([tab("Z")]);
    expect(screen.getByRole("button", { name: "Next Tab" })).toBeDisabled();
  });

  it("scrolls the active tab into view when it changes", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    seed([tab("A", { title: "a" }), tab("B", { title: "b" })]);
    render(<TabBar />);
    expect(spy.mock.contexts.at(-1)).toBe(tabEl("a"));
    act(() => selectTab("B"));
    expect(spy.mock.contexts.at(-1)).toBe(tabEl("b"));
  });

  it("+ adds a new Untitled tab and selects it", () => {
    seed([tab("A", { title: "a" })]);
    render(<TabBar />);
    const plus = screen.getByRole("button", { name: "New Network" });
    expect(plus).toHaveAttribute("title", "New Network in a new tab (File ▸ New Network, ⌘N)");
    fireEvent.click(plus);
    const ws = getWorkspace();
    expect(ws.tabs).toHaveLength(2);
    expect(ws.tabs[1]).toMatchObject({ title: "Untitled", path: null });
    expect(ws.activeId).toBe(ws.tabs[1].id);
  });
});
