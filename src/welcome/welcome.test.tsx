// The Welcome view and the toolbar's Solve button against the mock backend (new in 2.1, ROADMAP
// C1; ledger UX-101…112): when the view shows and when it goes, each of its states, the keyboard,
// the first network, what a card says about an example, and the preview's file list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers, type MockOptions } from "../dev/mockBackend";
import { closedExampleFiles, exampleFiles, extendedExampleFiles } from "../dev/mock/documents";
import { pickPath } from "../dev/mock/picker";
import { mockRuns } from "../dev/mock/runs";
import { activeEditor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, registerCommands, runCommand, unavailableReason } from "../lib/commands";
import { getSetting, getStateValue, loadKv } from "../lib/kv";
import { MENU_SPEC, specItem } from "../lib/menuSpec";
import { holdModal } from "../lib/overlays";
import { resetAdvice } from "../panes/results/agreement/chooser";
import { resetAgreementCommands, startAgreementCommands } from "../panes/results/agreement/commands";
import { resetSequence } from "../panes/results/agreement/runner";
import { resetRuns } from "../runs/state";
import { extendMock, mockCalls, mockTauri } from "../test/tauri";
import { RECENTS_KEY } from "../workspace/files/recents";
import { activeTab, addTab, getWorkspace, isBlankTab, selectTab, setDocument } from "../workspace/store";
import { restoreSession } from "../workspace/tabs/session";
import { classCount, describe as describeFacts, factsOf, hasCycle, matchesFilter, matchesQuery } from "./describe";
import { loadExamples, resetExamples } from "./examples";
import { closeWelcome, openWelcome, resetWelcome, SHOW_AT_LAUNCH_KEY, TOUR_COMMAND, useWelcomeCommands, welcomeMode, WelcomeHost } from "./index";
import { SolveToolbarButton } from "./SolveButton";
import { AnimationEngine } from "../animate/engine";
import { startTandem, TANDEM } from "./starts";
import { solveButtonWords, welcomeWords as w } from "./words";

const FILES = exampleFiles();
const CLOSED = Object.keys(closedExampleFiles()).length;
// The examples of the model features new in 2.1 (priorities, batch arrivals, a rate profile).
const EXTENDED = Object.keys(extendedExampleFiles()).length;
const COUNT = Object.keys(FILES).length + CLOSED + EXTENDED;
const resaved = import.meta.glob("../../golden/*/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const doc = (name: string): BnetDocument => JSON.parse(resaved[`../../golden/${name}/resave.bnet`]);

function Harness() {
  useWelcomeCommands();
  return (
    // The work area: the panes under the view, then the view.
    <main>
      <div className="pane-layout" data-testid="panes" />
      <WelcomeHost />
    </main>
  );
}

/** A launch: the backend, the settings and the session restore, then the main window's work area. */
async function launch(opts: MockOptions = {}) {
  mockTauri(defaultHandlers(opts));
  render(<Harness />);
  await act(async () => {
    await loadKv();
    await restoreSession();
  });
}

const view = () => screen.queryByRole("region", { name: w.label });
const cards = () => [...document.querySelectorAll<HTMLButtonElement>("[data-example]")];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  resetWelcome();
  resetExamples();
});
afterEach(async () => {
  // The list is a shared read (src/lib/api.ts): let one in flight land before the next test's backend.
  await loadExamples();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("what a card says about a network", () => {
  it("reads the counts, the buffer regime and the shape of the routing from the file", () => {
    expect(factsOf(doc("2dtandem"))).toMatchObject({ stations: 2, classes: 1, shape: "tandem" });
    expect(factsOf(doc("MM1K.d1.c1.fin"))).toMatchObject({ stations: 1, classes: 1, infinite: false, shape: "single" });
    expect(factsOf(doc("OpenJackson.d2.feedback.p30.inf"))).toMatchObject({ stations: 2, infinite: true, shape: "feedback" });
    expect(factsOf(doc("KumarSeidman90.d2.c4.reentrant.inf"))).toMatchObject({ stations: 2, classes: 4, shape: "reentrant" });
    expect(factsOf(doc("10stationtandem.inf"))).toMatchObject({ stations: 10, shape: "tandem", infinite: true });
    expect(describeFacts(factsOf(doc("10stationtandem.inf")))).toBe("10 stations · 1 customer class · infinite buffers. Stations in a row: every customer visits each one once.");
    expect(describeFacts(factsOf(doc("MM1K.d1.c1.fin")))).toBe("1 station · 1 customer class · finite buffers. One queue: the place to start.");
  });

  it("counts classes as the editor does, and finds a cycle only where the links make one", () => {
    const n = (id: string) => ({ id, kind: "station" as const });
    const l = (a: string, b: string, c = 0, to?: number) => ({ fromNodeID: a, toNodeID: b, customerClass: c, toCustomerClass: to });
    expect(hasCycle({ nodes: [n("a"), n("b")], links: [l("a", "b")] } as never)).toBe(false);
    expect(hasCycle({ nodes: [n("a"), n("b"), n("c")], links: [l("a", "b"), l("a", "c"), l("b", "c")] } as never)).toBe(false);
    expect(hasCycle({ nodes: [n("a")], links: [l("a", "a")] } as never)).toBe(true);
    expect(hasCycle({ nodes: [n("a"), n("b"), n("c")], links: [l("a", "b"), l("b", "c"), l("c", "a")] } as never)).toBe(true);
    expect(classCount({ nodes: [], links: [l("a", "b", 0, 2)] } as never)).toBe(3);
  });

  it("describes every bundled example, each from its own file", async () => {
    mockTauri(defaultHandlers());
    const all = await loadExamples();
    expect(all).toHaveLength(COUNT);
    expect(COUNT).toBeGreaterThanOrEqual(40);
    for (const e of all) {
      expect(e.description, e.name).toMatch(/^\d+ stations? · (\d+ customer class(es)?|\d+ customers? circulating) · (in)?finite buffers\. \S/);
      expect(e.facts.stations, e.name).toBe(e.document.nodes.filter((x) => x.kind === "station").length);
      expect(e.facts.infinite, e.name).toBe(e.document.infiniteBuffers);
    }
    // The bundled closed example is in the gallery, described as a closed network (not as a
    // generic feedback network), under its own filter and not under Feedback.
    expect(CLOSED).toBeGreaterThanOrEqual(1);
    const closed = all.filter((e) => matchesFilter(e.facts, "closed"));
    expect(closed.map((e) => e.name)).toEqual(["ClosedCentralServer.d3.N8"]);
    expect(closed[0].description).toBe("3 stations · 8 customers circulating · infinite buffers. A closed network: no source and no sink, the same customers circulate for ever. Has stations with several servers.");
    expect(matchesFilter(closed[0].facts, "feedback")).toBe(false);
    expect(all.filter((e) => e.facts.shape !== "closed").every((e) => e.facts.population === null && !e.description.includes("closed"))).toBe(true);
    // An open network that carries a population is described as the open network it is.
    expect(factsOf({ ...doc("OpenJackson.d2.feedback.p30.inf"), closedPopulation: 5 })).toMatchObject({ shape: "feedback", population: null });
    // The filters and the search go by the same facts.
    expect(all.filter((e) => matchesFilter(e.facts, "finite")).every((e) => !e.document.infiniteBuffers)).toBe(true);
    expect(all.filter((e) => matchesFilter(e.facts, "multiclass")).every((e) => e.facts.classes > 1)).toBe(true);
    expect(matchesQuery("2dtandem", "2 stations", "TANDEM 2")).toBe(true);
    expect(matchesQuery("2dtandem", "2 stations", "tandem feedback")).toBe(false);
  });
});

describe("when the view shows", () => {
  it("holds whichever pane layout is under it, also one that replaced the first while it was open (review)", async () => {
    await launch();
    const first = screen.getByTestId("panes");
    const area = first.parentElement!;
    // A pane is detached or docked again: the layout element is a new one.
    const second = document.createElement("div");
    second.className = "pane-layout";
    act(() => {
      first.remove();
      area.prepend(second);
    });
    await settle();
    expect(second).toHaveAttribute("inert");
    act(() => closeWelcome());
    expect(second).not.toHaveAttribute("inert");
  });

  it("shows at launch over the blank Untitled tab, with the focus on the first action (UX-101)", async () => {
    await launch();
    expect(view()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: w.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`^${w.tandem}`) })).toHaveFocus();
    // The panes underneath are out of reach while it covers them, and back when it goes.
    expect(screen.getByTestId("panes")).toHaveAttribute("inert");
    act(() => closeWelcome());
    expect(view()).not.toBeInTheDocument();
    expect(screen.getByTestId("panes")).not.toHaveAttribute("inert");
  });

  it("stays away at launch when the setting is off, or when the session restored a network (UX-101, UX-109)", async () => {
    await launch({ settings: { [SHOW_AT_LAUNCH_KEY]: false } });
    expect(view()).not.toBeInTheDocument();
    expect(welcomeMode()).toBe("closed");
  });

  it("never covers a network: opening it over one selects a blank tab, and the first node sends it away (UX-110)", async () => {
    await launch();
    act(() => setDocument(activeTab().id, doc("2dtandem")));
    expect(view()).not.toBeInTheDocument();
    const withNetwork = activeTab().id;
    await act(async () => void (await runCommand("help:welcome")));
    expect(view()).toBeInTheDocument();
    expect(activeTab().id).not.toBe(withNetwork);
    expect(isBlankTab(activeTab())).toBe(true);
    expect(getWorkspace().tabs).toHaveLength(2);
    // Back on the network's tab there is no view; asked for again, the same blank tab is reused.
    act(() => selectTab(withNetwork));
    expect(view()).not.toBeInTheDocument();
    await act(async () => void (await runCommand("window:welcome")));
    expect(getWorkspace().tabs).toHaveLength(2);
    expect(view()).toBeInTheDocument();
    act(() => setDocument(activeTab().id, doc("2dtandem")));
    expect(view()).not.toBeInTheDocument();
  });

  it("goes as soon as a drawing tool is picked (UX-110)", async () => {
    await launch();
    expect(view()).toBeInTheDocument();
    act(() => activeEditor().setTool("addStation"));
    expect(view()).not.toBeInTheDocument();
    expect(welcomeMode()).toBe("closed");
  });

  it("is in the Help and Window menus, and waits for an open dialog", async () => {
    await launch();
    expect(specItem("help:welcome", MENU_SPEC)?.label).toBe("Welcome to Qnet");
    expect(specItem("window:welcome", MENU_SPEC)?.label).toBe("Welcome to Qnet");
    const release = holdModal();
    expect(unavailableReason(getCommand("help:welcome")!)).toBe("Close the open dialog first");
    release();
    expect(unavailableReason(getCommand("help:welcome")!)).toBeNull();
  });
});

describe("the start actions", () => {
  it("Start with a Tandem Line puts a valid, stable two-station line in the blank tab (UX-102)", async () => {
    await launch();
    const tab = activeTab().id;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${w.tandem}`) }));
    await waitFor(() => expect(activeTab().document.nodes.length).toBeGreaterThan(0));
    await waitFor(() => expect(view()).not.toBeInTheDocument());
    expect(activeTab().id).toBe(tab);
    const d = activeTab().document;
    const names = d.nodes.map((n) => n.name);
    expect(names).toEqual(["Src1", "B1", "S1", "B2", "S2", "Sink1"]);
    expect(d.infiniteBuffers).toBe(true);
    // One route, source to sink, every link certain.
    const byId = new Map(d.nodes.map((n) => [n.id, n.name]));
    expect(d.links.map((l) => `${byId.get(l.fromNodeID)}>${byId.get(l.toNodeID)}`).sort()).toEqual(["B1>S1", "B2>S2", "S1>B2", "S2>Sink1", "Src1>B1"]);
    expect(d.links.every((l) => l.routingProbability === 1 && l.customerClass === 0)).toBe(true);
    // Stable: each station serves faster than customers arrive (ρ = λ/μ = 0.8).
    const rate = (params: string) => Number(/(?:rate|lambda)=([^,]+)/.exec(params)![1]);
    const lambda = rate(d.nodes[0].distributionParameters);
    expect(lambda).toBe(TANDEM.arrivalRate);
    for (const s of d.nodes.filter((n) => n.kind === "station")) {
      expect(s.numberOfServers).toBe(1);
      const mu = rate(s.serviceDistributions["0"]?.distributionParameters ?? s.distributionParameters);
      expect(lambda / mu).toBe(0.8);
    }
    // Laid out on one row, left to right, and nothing left selected.
    expect(new Set(d.nodes.map((n) => n.position[1])).size).toBe(1);
    const xs = d.nodes.map((n) => n.position[0]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(activeEditor().view.selectedNodeIDs.size).toBe(0);
    expect(activeTab().log.map((x) => x.text)).toContain(w.tandemStatus);
    // It is a network View ▸ Animate plays (infinite buffers; src-tauri's test holds the real simulator to it).
    const engine = new AnimationEngine();
    await act(async () => void (await engine.start(d, 1, { play: false })));
    expect([engine.phase, engine.message]).toEqual(["running", ""]);
    engine.dispose();
    // One undo step takes it away again.
    act(() => activeEditor().undo());
    expect(activeTab().document.nodes).toHaveLength(0);
  });

  it("the tandem line goes into a new tab when the active one has a network", async () => {
    mockTauri(defaultHandlers());
    act(() => setDocument(activeTab().id, doc("MM1K.d1.c1.fin")));
    const before = activeTab().id;
    await act(async () => void (await startTandem()));
    expect(getWorkspace().tabs).toHaveLength(2);
    expect(activeTab().id).not.toBe(before);
    expect(activeTab().document.nodes).toHaveLength(6);
  });

  it("New Empty Network and Escape leave the blank canvas; Open… runs File ▸ Open (UX-103, UX-104)", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${w.empty}`) }));
    expect(view()).not.toBeInTheDocument();
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(isBlankTab(activeTab())).toBe(true);

    act(() => openWelcome());
    fireEvent.keyDown(screen.getByRole("button", { name: new RegExp(`^${w.open}`) }), { key: "Escape" });
    expect(view()).not.toBeInTheDocument();

    act(() => openWelcome());
    const ran = vi.fn();
    const remove = registerCommands([{ id: "file:open", title: "Open…", group: "File", run: ran }]);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${w.open}`) }));
    expect(ran).toHaveBeenCalledTimes(1);
    // Cancelling the panel changes nothing: the view is still there.
    expect(view()).toBeInTheDocument();
    remove();
  });

  it("offers the tour only while its command is registered, and runs it with the view gone (the hook for the tour)", async () => {
    await launch();
    expect(screen.queryByRole("button", { name: new RegExp(`^${w.tour}`) })).not.toBeInTheDocument();
    const ran = vi.fn();
    let remove = () => {};
    act(() => {
      remove = registerCommands([{ id: TOUR_COMMAND, title: "Take the Tour", group: "Help", run: ran }]);
    });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${w.tour}`) }));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(view()).not.toBeInTheDocument();
    act(() => remove());
  });
});

describe("recent files", () => {
  it("says what will be listed when there are none (UX-105)", async () => {
    await launch();
    const recent = screen.getByRole("region", { name: w.recentHeading });
    expect(within(recent).getByText(w.recentEmptyTitle)).toBeInTheDocument();
    expect(within(recent).getByText(w.recentEmpty)).toBeInTheDocument();
    expect(within(recent).queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists File ▸ Open Recent's files, newest first, and opens one into the blank tab (UX-105)", async () => {
    await launch({ state: { [RECENTS_KEY]: ["/examples/3dtandem.inf.bnet", "/examples/2dtandem.bnet"] } });
    const recent = screen.getByRole("region", { name: w.recentHeading });
    const items = within(recent).getAllByRole("button");
    expect(items.map((b) => b.getAttribute("aria-label"))).toEqual(["Open 3dtandem.inf.bnet", "Open 2dtandem.bnet"]);
    expect(items[1]).toHaveAttribute("title", "/examples/2dtandem.bnet");
    fireEvent.click(items[1]);
    await waitFor(() => expect(activeTab().title).toBe("2dtandem.bnet"));
    await waitFor(() => expect(view()).not.toBeInTheDocument());
    expect(getWorkspace().tabs).toHaveLength(1);
    await waitFor(() => expect(getStateValue<string[]>(RECENTS_KEY, [])[0]).toBe("/examples/2dtandem.bnet"));
  });
});

describe("the example gallery", () => {
  it("shows every bundled example as a card with its diagram, name and description (UX-106)", async () => {
    await launch();
    await waitFor(() => expect(cards()).toHaveLength(COUNT));
    const card = cards().find((c) => c.dataset.example === "2dtandem")!;
    expect(card).toHaveAccessibleName("Open 2dtandem: 2 stations · 1 customer class · finite buffers. Stations in a row: every customer visits each one once.");
    // The diagram is the canvas's own drawing: its link and node layers, fitted to the frame.
    await waitFor(() => expect(card.querySelector(".qn-welcome-thumb svg")).not.toBeNull());
    const svg = card.querySelector(".qn-welcome-thumb svg")!;
    expect(svg).toHaveAttribute("data-snapshot", "true");
    expect(svg.getAttribute("width")).toBe("200");
    expect(svg.querySelector('[data-layer="nodes"]')!.childElementCount).toBe(doc("2dtandem").nodes.length);
    expect(svg.querySelector('[data-layer="grid"]')).toBeNull();
    expect(screen.getByText(`${COUNT} examples`)).toBeInTheDocument();
    expect(mockCalls.filter((c) => c.cmd === "examples_list")).toHaveLength(1);
  });

  it("draws a diagram only when its card comes near the visible part of the list (UX-106)", async () => {
    const watched: { el: Element; cb: IntersectionObserverCallback }[] = [];
    class IO {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        watched.push({ el, cb: this.cb });
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", IO);
    await launch();
    await waitFor(() => expect(cards()).toHaveLength(COUNT));
    expect(watched).toHaveLength(COUNT);
    expect(document.querySelectorAll(".qn-welcome-thumb svg")).toHaveLength(0);
    act(() => watched[3].cb([{ isIntersecting: true, target: watched[3].el } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(document.querySelectorAll(".qn-welcome-thumb svg")).toHaveLength(1);
    expect(watched[3].el.querySelector("svg")).not.toBeNull();
  });

  it("filters by kind and by search, and says so when nothing matches (UX-107)", async () => {
    await launch();
    await waitFor(() => expect(cards()).toHaveLength(COUNT));
    const all = await loadExamples();
    const chips = screen.getByRole("group", { name: w.filterLabel });
    fireEvent.click(within(chips).getByRole("button", { name: w.filters.finite }));
    const finite = all.filter((e) => !e.document.infiniteBuffers).length;
    expect(cards()).toHaveLength(finite);
    expect(within(chips).getByRole("button", { name: w.filters.finite })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(`${finite} of ${COUNT} examples`)).toBeInTheDocument();

    // Closed networks have a chip of their own.
    fireEvent.click(within(chips).getByRole("button", { name: "Closed" }));
    expect(cards().map((c) => c.dataset.example)).toEqual(["ClosedCentralServer.d3.N8"]);
    expect(cards()[0]).toHaveAccessibleName(/8 customers circulating .* A closed network: no source and no sink/);
    fireEvent.click(within(chips).getByRole("button", { name: w.filters.finite }));

    const search = screen.getByRole("searchbox", { name: w.search });
    fireEvent.change(search, { target: { value: "mm1k" } });
    expect(cards().map((c) => c.dataset.example)).toEqual(["MM1K.d1.c1.fin"]);
    // Escape in the field clears the search first; it does not close the view.
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(view()).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no such network" } });
    expect(cards()).toHaveLength(0);
    expect(screen.getByText(w.examplesNoMatchTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: w.clearSearch }));
    expect(cards()).toHaveLength(COUNT);
  });

  it("is one Tab stop walked with the arrow keys; Enter or a click opens the example in the tab (UX-108)", async () => {
    await launch();
    await waitFor(() => expect(cards()).toHaveLength(COUNT));
    expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    cards()[0].focus();
    fireEvent.keyDown(cards()[0], { key: "ArrowRight" });
    expect(cards()[1]).toHaveFocus();
    expect(cards()[1].tabIndex).toBe(0);
    expect(cards()[0].tabIndex).toBe(-1);
    fireEvent.keyDown(cards()[1], { key: "End" });
    expect(cards()[COUNT - 1]).toHaveFocus();
    fireEvent.keyDown(cards()[COUNT - 1], { key: "Home" });
    fireEvent.keyDown(cards()[0], { key: "ArrowLeft" });
    expect(cards()[0]).toHaveFocus();
    // A card is a button: Enter is its click.
    const name = cards()[0].dataset.example!;
    fireEvent.click(cards()[0]);
    await waitFor(() => expect(activeTab().title).toBe(`${name}.bnet`));
    await waitFor(() => expect(view()).not.toBeInTheDocument());
    expect(activeTab().path).toBe(`/examples/${name}.bnet`);
    expect(activeTab().document.nodes.length).toBeGreaterThan(0);
    expect(getWorkspace().tabs).toHaveLength(1);
  });

  it("says so when the examples are not found", async () => {
    mockTauri({ ...defaultHandlers(), examples_list: () => [] });
    render(<Harness />);
    await act(async () => {
      await loadKv();
      await restoreSession();
    });
    expect(await screen.findByText(w.examplesNoneTitle)).toBeInTheDocument();
    expect(cards()).toHaveLength(0);
  });
});

describe("Show this at launch", () => {
  it("is the setting welcome.showAtLaunch, and unticking it leaves the view up this time (UX-109)", async () => {
    await launch();
    const box = screen.getByRole("checkbox", { name: w.showAtLaunch });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(getSetting<boolean>(SHOW_AT_LAUNCH_KEY, true)).toBe(false));
    await settle();
    expect(view()).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: w.showAtLaunch })).not.toBeChecked();
    expect(mockCalls.some((c) => c.cmd === "settings_patch" && (c.args.patch as Record<string, unknown>)[SHOW_AT_LAUNCH_KEY] === false)).toBe(true);
  });
});

describe("the toolbar's Solve button", () => {
  beforeEach(async () => {
    mockTauri(defaultHandlers());
    mockRuns.replayMs = 5;
    resetRuns();
    resetSequence();
    resetAdvice();
    resetAgreementCommands();
    startAgreementCommands();
    await loadKv();
  });

  it("with no network it can't run, stays focusable and says why (UX-111)", () => {
    render(<SolveToolbarButton />);
    const b = screen.getByRole("button", { name: /^Solve/ });
    expect(b).toHaveAttribute("aria-disabled", "true");
    expect(b).toHaveAttribute("title", solveButtonWords.emptyHelp);
    expect(b).not.toBeDisabled();
    fireEvent.click(b);
    expect(mockRuns.starts).toHaveLength(0);
  });

  it("runs Run ▸ Solve's own command and shows the run in progress (UX-111, UX-112)", async () => {
    mockRuns.replayMs = 150;
    act(() => void addTab({ title: "2dtandem.bnet", path: "/examples/2dtandem.bnet", document: doc("2dtandem") }));
    render(<SolveToolbarButton />);
    const b = screen.getByRole("button", { name: "Solve" });
    expect(b).toHaveAttribute("aria-disabled", "false");
    expect(b.getAttribute("title")).toMatch(/\(⌘↩\)$/);
    fireEvent.click(b);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Solving…/ })).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: /^Solving…/ })).toHaveAttribute("title", solveButtonWords.runningHelp);
    // A second press while it runs starts nothing.
    fireEvent.click(screen.getByRole("button", { name: /^Solving…/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Solve" })).toHaveAttribute("aria-disabled", "false"), { timeout: 4000 });
    expect(mockRuns.starts).toHaveLength(1);
  });
});

describe("the preview's Open panel", () => {
  it("lists the preview's files, the panel's folder first, and resolves to the one clicked", async () => {
    const pick = pickPath(document, { title: "Open Example", folder: "/examples", paths: ["/saved/mine.bnet", "/examples/b.bnet", "/examples/a.bnet"] });
    const dialog = screen.getByRole("dialog", { name: "Open Example" });
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["a.bnet", "b.bnet", "mine.bnet"]);
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.click(options[1]);
    expect(await pick).toBe("/examples/b.bnet");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape and Cancel choose nothing", async () => {
    const first = pickPath(document, { title: "Open", paths: ["/examples/a.bnet"] });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await first).toBeNull();
    const second = pickPath(document, { title: "Open", paths: [] });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await second).toBeNull();
    expect(extendMock).toBeTypeOf("function");
  });
});
