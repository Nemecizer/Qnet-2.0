// The files area against the mock backend: New, Open, Open Recent, Open Example, Save, Save As,
// the solver-input exports and Generate Random Network, in 0.90.34's words (ledger 5.9, 1.2,
// 8.1, 8.7, 14.6, 14.8).
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { exampleFiles } from "../../dev/mock/documents";
import { emptyDocument, type BnetDocument } from "../../lib/bnet";
import { getCommand, runCommand, unavailableReason } from "../../lib/commands";
import { getStateValue } from "../../lib/kv";
import { resolveMenu, type MenuNode } from "../../lib/menu";
import { MENU_SPEC } from "../../lib/menuSpec";
import { holdModal, modalOpen } from "../../lib/overlays";
import { mockCalls, mockTauri, type MockHandlers } from "../../test/tauri";
import { activeTab, addTab, getWorkspace, isDirty, setDocument, updateTab } from "../store";
import { FilesHost, saveTab, useFileCommands } from "./index";
import { nextRandomTitle, parseNumber, parseSeed, randomProblem, RANDOM_DEFAULTS } from "./generate";
import { RECENTS_KEY, RECENTS_LIMIT, noteRecent } from "./recents";
import { closeSheet } from "./sheets";
import { inferSeverity } from "./status";

afterEach(() => act(() => closeSheet()));

const EX = "/examples/2dtandem.bnet";
const exampleDoc = (name = "2dtandem.bnet"): BnetDocument => JSON.parse(exampleFiles()[`/examples/${name}`]);

function Harness() {
  useFileCommands();
  return (
    <>
      <FilesHost />
      <DialogHost />
    </>
  );
}

/** Installs the mock backend plus `extra`, renders the files area, and returns the panel requests. */
function setup(extra: MockHandlers = {}, answers: { open?: (string | null)[]; save?: (string | null)[] } = {}) {
  const panels: { kind: string; options: Record<string, unknown> }[] = [];
  const open = [...(answers.open ?? [])];
  const save = [...(answers.save ?? [])];
  mockTauri({
    ...defaultHandlers(),
    "plugin:dialog|open": ({ options }: { options: Record<string, unknown> }) => {
      panels.push({ kind: "open", options });
      return open.shift() ?? null;
    },
    "plugin:dialog|save": ({ options }: { options: Record<string, unknown> }) => {
      panels.push({ kind: "save", options });
      return save.shift() ?? null;
    },
    ...extra,
  });
  render(<Harness />);
  return panels;
}

const log = (t = activeTab()) => t.log.map((e) => [e.severity, e.text]);
const reason = (id: string) => unavailableReason(getCommand(id)!);

describe("New and Open", () => {
  it("New Network appends an empty Untitled tab, selected and clean (WS-108, MENU-009, WS-126)", async () => {
    setup();
    const first = getWorkspace().activeId;
    await act(() => runCommand("file:new"));
    const ws = getWorkspace();
    expect(ws.tabs).toHaveLength(2);
    expect(ws.activeId).not.toBe(first);
    expect(activeTab()).toMatchObject({ title: "Untitled", path: null });
    expect(isDirty(activeTab())).toBe(false);
    expect(getCommand("file:new")!.subtitle).toBe("Open an empty canvas in a new tab");
  });

  it("Open… shows “Open Network” for one .bnet and loads it into the blank active tab (WS-109, WS-110, FILE-015, MENU-010)", async () => {
    const panels = setup({}, { open: [EX] });
    const blank = getWorkspace().activeId;
    await act(() => runCommand("file:open"));
    expect(panels[0]).toMatchObject({ kind: "open", options: { title: "Open Network", multiple: false, directory: false, filters: [{ extensions: ["bnet"] }] } });
    const t = activeTab();
    expect(t.id).toBe(blank);
    expect(t).toMatchObject({ title: "2dtandem.bnet", path: EX });
    expect(isDirty(t)).toBe(false);
    const doc = exampleDoc();
    expect(log(t)).toEqual([
      ["success", `Loaded network with ${doc.nodes.length} nodes and ${doc.links.length} links.`],
      ["success", "Loaded 2dtandem.bnet."],
    ]);
    expect(getStateValue(RECENTS_KEY, [])).toEqual([EX]);
  });

  it("opens into a new selected tab when the active one has a network or a file (FILE-015)", async () => {
    setup({}, { open: [EX] });
    setDocument(activeTab().id, exampleDoc("3d3cfin.bnet"));
    await act(() => runCommand("file:open"));
    expect(getWorkspace().tabs).toHaveLength(2);
    expect(activeTab().title).toBe("2dtandem.bnet");
    expect(getWorkspace().tabs[0].log).toEqual([]);
  });

  it("a file that can't be read gives the critical “Load Failed” alert and an error line (WS-112, FILE-016)", async () => {
    setup({}, { open: ["/nowhere/missing.bnet"] });
    act(() => void runCommand("file:open"));
    const alert = await screen.findByRole("alertdialog", { name: "Load Failed" });
    expect(alert).toHaveTextContent("Qnet couldn't read “missing.bnet”.");
    expect(log()).toEqual([["error", "Load failed: Qnet couldn't read “missing.bnet”."]]);
    fireEvent.click(within(alert).getByRole("button", { name: "OK" }));
    expect(getWorkspace().tabs).toHaveLength(1);
  });

  it("a cancelled panel opens nothing", async () => {
    setup({}, { open: [null] });
    await act(() => runCommand("file:open"));
    expect(getWorkspace().tabs).toHaveLength(1);
    expect(log()).toEqual([]);
  });
});

describe("Open Example", () => {
  it("starts in the bundled examples folder, and the example stays file-backed so Save writes it back (WS-113, WS-116, EX-052)", async () => {
    const panels = setup({}, { open: [EX] });
    await act(() => runCommand("file:open-example"));
    expect(panels[0].options).toMatchObject({ title: "Open Example", defaultPath: "/examples", filters: [{ extensions: ["bnet"] }] });
    expect(activeTab().path).toBe(EX);
    expect(getCommand("file:open-example")!.subtitle).toBe("Open one of the bundled literature networks");
    setDocument(activeTab().id, { ...activeTab().document, canvasScale: 2 });
    await act(() => runCommand("file:save"));
    expect(mockCalls.filter((c) => c.cmd === "document_write").map((c) => c.args.path)).toEqual([EX]);
  });

  it("with no examples folder, logs the paths tried and opens the panel at home (WS-115, EX-054)", async () => {
    const panels = setup({ examples_locate: () => ({ path: null, searched: ["/a", "/b"], trail: "/a, /b", home: "/Users/me" }) }, { open: [null] });
    await act(() => runCommand("file:open-example"));
    expect(log()).toEqual([
      ["warning", "No examples directory found — looked in: /a, /b."],
      ["info", "The bundled examples could not be found. Choose a .bnet file, or see the Status pane for the paths that were tried."],
    ]);
    expect(panels[0].options.defaultPath).toBe("/Users/me");
  });
});

describe("Save and Save As", () => {
  it("Save is enabled for an untitled network with content, and for a file only while edited, with 0.90.34's tooltips (WS-117, MENU-019)", async () => {
    setup({}, { open: [EX] });
    expect(reason("file:save")).toBe("Draw or open a network first");
    expect(reason("file:save-as")).toBe("Draw or open a network first");
    await act(() => runCommand("file:open"));
    expect(reason("file:save")).toBe("No unsaved changes");
    expect(reason("file:save-as")).toBeNull();
    setDocument(activeTab().id, { ...activeTab().document, canvasScale: 2 });
    expect(reason("file:save")).toBeNull();
    expect(getCommand("file:save")!.subtitle).toBe("Save the network to its .bnet file");
    addTab({ document: exampleDoc() });
    expect(reason("file:save")).toBeNull();
  });

  it("an untitled network goes through “Save Network As”, then is clean, named after its file, logged and recent (WS-118, WS-119, FILE-013, FILE-014, MENU-021)", async () => {
    const panels = setup({}, { save: ["/work/tandem.bnet"] });
    setDocument(activeTab().id, exampleDoc());
    await act(() => runCommand("file:save"));
    expect(panels[0]).toMatchObject({ kind: "save", options: { title: "Save Network As", defaultPath: "Untitled.bnet", filters: [{ extensions: ["bnet"] }], canCreateDirectories: true } });
    const t = activeTab();
    expect(t).toMatchObject({ title: "tandem.bnet", path: "/work/tandem.bnet" });
    expect(isDirty(t)).toBe(false);
    expect(log(t)).toEqual([["success", "Saved network to tandem.bnet."]]);
    expect(getStateValue(RECENTS_KEY, [])).toEqual(["/work/tandem.bnet"]);
  });

  it("Save As offers the file's own name in its folder (MENU-020, FILE-014)", async () => {
    const panels = setup({}, { open: [EX], save: ["/elsewhere/copy.bnet"] });
    await act(() => runCommand("file:open"));
    await act(() => runCommand("file:save-as"));
    expect(panels[1].options).toMatchObject({ title: "Save Network As", defaultPath: "/examples/2dtandem.bnet" });
    expect(activeTab()).toMatchObject({ title: "copy.bnet", path: "/elsewhere/copy.bnet" });
    expect(getStateValue(RECENTS_KEY, [])).toEqual(["/elsewhere/copy.bnet", EX]);
  });

  it("a failed save shows “Save Failed”, logs the error and leaves the tab as it was (WS-120, FILE-013)", async () => {
    setup({ document_write: () => Promise.reject({ kind: "failed", message: "Qnet couldn't save “t.bnet”.", detail: "Permission denied" }) }, { save: ["/ro/t.bnet"] });
    setDocument(activeTab().id, exampleDoc());
    let ok: boolean | undefined;
    act(() => void saveTab(activeTab().id).then((r) => (ok = r)));
    const alert = await screen.findByRole("alertdialog", { name: "Save Failed" });
    expect(alert).toHaveTextContent("Qnet couldn't save “t.bnet”.");
    fireEvent.click(within(alert).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(ok).toBe(false));
    expect(activeTab()).toMatchObject({ title: "Untitled", path: null });
    expect(isDirty(activeTab())).toBe(true);
    expect(log()).toEqual([["error", "Save failed: Qnet couldn't save “t.bnet”."]]);
  });

  it("saveTab saves a tab that isn't the front one, and resolves false when the panel is cancelled", async () => {
    setup({}, { save: [null, "/w/b.bnet"] });
    const back = getWorkspace().activeId;
    setDocument(back, exampleDoc());
    addTab();
    expect(await saveTab(back)).toBe(false);
    expect(await saveTab(back)).toBe(true);
    expect(getWorkspace().tabs[0]).toMatchObject({ title: "b.bnet", path: "/w/b.bnet" });
    expect(activeTab().title).toBe("Untitled");
  });
});

describe("Open Recent", () => {
  const recentMenu = () => {
    const file = resolveMenu().find((n): n is Extract<MenuNode, { type: "submenu" }> => n.type === "submenu" && n.label === "File")!;
    return file.items.find((n): n is Extract<MenuNode, { type: "submenu" }> => n.type === "submenu" && n.label === "Open Recent")!.items;
  };

  it("lists files newest first by name, then a divider and Clear Menu, which is dimmed when empty (MENU-011, MENU-012, WS-121)", async () => {
    setup();
    expect(recentMenu()).toEqual([{ type: "item", id: "file:clear-recent", label: "Clear Menu", enabled: false }]);
    await noteRecent("/a/one.bnet");
    await noteRecent("/b/two.bnet");
    await noteRecent("/a/one.bnet");
    expect(recentMenu().map((n) => (n.type === "item" ? n.label : n.type))).toEqual(["one.bnet", "two.bnet", "separator", "Clear Menu"]);
    expect(recentMenu().at(-1)).toMatchObject({ enabled: true });
    await act(() => runCommand("file:clear-recent"));
    expect(getStateValue(RECENTS_KEY, null)).toEqual([]);
  });

  it("keeps the system's ten, and a chosen entry opens like Open… (WS-121, WS-122)", async () => {
    setup();
    for (let i = 0; i < 12; i++) await noteRecent(`/x/n${i}.bnet`);
    expect(getStateValue<string[]>(RECENTS_KEY, [])).toHaveLength(RECENTS_LIMIT);
    expect(getStateValue<string[]>(RECENTS_KEY, [])[0]).toBe("/x/n11.bnet");
    await noteRecent(EX);
    const { runMenuItem } = await import("../../lib/menu");
    const item = recentMenu().find((n) => n.type === "item" && n.label === "2dtandem.bnet") as { id: string };
    act(() => runMenuItem(item.id));
    await waitFor(() => expect(activeTab().title).toBe("2dtandem.bnet"));
  });
});

describe("the solver-input exports", () => {
  const withFile = () => updateTab(activeTab().id, { path: "/work/net.bnet", title: "net.bnet", document: exampleDoc() });

  it("are dimmed with no network or while a sheet is up (MENU-024…027)", () => {
    setup();
    for (const id of ["file:export-fbnasim", "file:export-srbm", "file:export-qna", "file:export-all"]) expect(reason(id)).toBe("Draw or open a network first");
    withFile();
    expect(reason("file:export-qna")).toBeNull();
    const release = holdModal();
    expect(reason("file:export-qna")).toBe("Close the open dialog first");
    expect(reason("network:random")).toBe("Close the open dialog first");
    release();
  });

  it("fBNAsim: the text, then the panel configured as every export panel, then “Exported network to …” (EXP-108, EXP-109, MENU-028)", async () => {
    const panels = setup({}, { save: ["/work/net.txt"] });
    withFile();
    await act(() => runCommand("file:export-fbnasim"));
    expect(panels[0].options).toMatchObject({ title: "Export Finite Simulator Input", defaultPath: "/work/net.txt", canCreateDirectories: true, filters: [{ extensions: ["txt"] }] });
    const text = mockCalls.find((c) => c.cmd === "export_text")!;
    expect(text.args).toMatchObject({ format: "fbnasim" });
    expect(typeof text.args.generated).toBe("string");
    expect(log()).toEqual([["success", "Exported network to net.txt."]]);
  });

  it("QNA: a refusal is logged with no panel; a write failure is logged too (EXP-110)", async () => {
    const panels = setup({ export_text: () => Promise.reject({ kind: "invalid", message: "The network has no stations." }) });
    updateTab(activeTab().id, { title: "Random 2", document: exampleDoc() });
    await act(() => runCommand("file:export-qna"));
    expect(panels).toEqual([]);
    expect(log()).toEqual([["error", "QNA export failed: The network has no stations."]]);

    const p2 = setup({ export_save: () => Promise.reject({ kind: "failed", message: "Permission denied" }) }, { save: ["/ro/Random 2.qna"] });
    updateTab(activeTab().id, { title: "Random 2", document: exampleDoc() });
    await act(() => runCommand("file:export-qna"));
    // No file: the tab title is the base name and there is no folder to start in (EXP-108).
    expect(p2[0].options).toMatchObject({ title: "Export QNA Input", defaultPath: "Random 2.qna", filters: [{ extensions: ["qna"] }, { extensions: ["txt"] }] });
    expect(log().at(-1)).toEqual(["error", "QNA export write failed: Permission denied"]);
  });

  it("the SRBM sheet shows the document, disables the picker for infinite buffers, and exports to <doc>.in (EXP-111…113, MENU-025)", async () => {
    const panels = setup({}, { save: ["/work/net.in"] });
    updateTab(activeTab().id, { path: "/work/net.bnet", title: "net.bnet", document: exampleDoc("3d3ctandem.inf.bnet") });
    await act(() => runCommand("file:export-srbm"));
    const sheet = screen.getByRole("dialog", { name: "Export SRBM Solver Input" });
    expect(sheet).toHaveTextContent("Writes the drift θ, covariance Γ, reflection matrix R and box dimensions read by srbm_solver and bnet.");
    expect(modalOpen()).toBe(true);
    const doc = exampleDoc("3d3ctandem.inf.bnet");
    const docSection = within(sheet).getByRole("region", { name: "Document" });
    expect(docSection).toHaveTextContent("Networknet");
    expect(docSection).toHaveTextContent(`Stations${doc.nodes.filter((n) => n.kind === "station").length}`);
    expect(docSection).toHaveTextContent(`Customer classes${new Set(doc.links.map((l) => l.customerClass)).size}`);
    expect(docSection).toHaveTextContent("BuffersInfinite (orthant)");
    expect(within(sheet).getByRole("combobox", { name: "Blocking convention" })).toBeDisabled();
    expect(sheet).toHaveTextContent("Infinite-buffer networks never block; the manufacturing convention is used.");
    expect(within(sheet).getByRole("button", { name: "What is Covariance Γ?" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(panels[0].options).toMatchObject({ title: "Export SRBM Solver Input", defaultPath: "/work/net.in", filters: [{ extensions: ["in"] }, { extensions: ["txt"] }] });
    expect(log()).toEqual([["success", "Exported SRBM solver input to /work/net.in."]]);
    expect(modalOpen()).toBe(false);
  });

  it("the SRBM sheet offers the three conventions for finite buffers, each with its footer, and blocks an empty network", async () => {
    setup({ export_text: () => Promise.reject({ kind: "invalid", message: "The network has no source node." }) });
    setDocument(activeTab().id, exampleDoc("3d3cfin.bnet"));
    await act(() => runCommand("file:export-srbm"));
    const sheet = screen.getByRole("dialog", { name: "Export SRBM Solver Input" });
    const picker = within(sheet).getByRole("combobox", { name: "Blocking convention" });
    expect([...(picker as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Manufacturing blocking (SRBM default)", "Loss-network correction", "BAS + external-loss correction"]);
    expect(sheet).toHaveTextContent("matches the spectral, finite-element and LP solvers.");
    fireEvent.change(picker, { target: { value: "bas" } });
    expect(sheet).toHaveTextContent("Adjusts drift for blocking-after-service with external loss (--bas-fix).");
    expect(within(sheet).getByRole("region", { name: "Document" })).toHaveTextContent("NetworkUntitled");
    // A refusal: the "Export Failed" alert and an error line; the sheet stays.
    fireEvent.click(within(sheet).getByRole("button", { name: "Export…" }));
    const alert = await screen.findByRole("alertdialog", { name: "Export Failed" });
    expect(alert).toHaveTextContent("The network has no source node.");
    expect(log()).toEqual([["error", "SRBM export failed: The network has no source node."]]);
    fireEvent.click(within(alert).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Export SRBM Solver Input" })).toBeInTheDocument();
    // An empty network: the footer says why and Export… is off.
    act(() => setDocument(activeTab().id, emptyDocument()));
    expect(screen.getByRole("dialog")).toHaveTextContent("The network is empty; add nodes before exporting.");
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
    // Escape is Cancel (KEY-029).
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Export All goes straight to the folder panel for infinite buffers and logs what it wrote (EXP-114, EXP-115, MENU-027)", async () => {
    const panels = setup({}, { open: ["/out"] });
    updateTab(activeTab().id, { path: "/work/net.bnet", title: "net.bnet", document: exampleDoc("3d3ctandem.inf.bnet") });
    await act(() => runCommand("file:export-all"));
    expect(panels[0].options).toMatchObject({ title: "Export All Solver Inputs", directory: true, canCreateDirectories: true, defaultPath: "/work" });
    expect(mockCalls.find((c) => c.cmd === "export_all_inputs")!.args).toMatchObject({ convention: "manufacturing", folder: "/out" });
    expect(log()).toEqual([["success", "Exported 7 solver input file(s) to /out: sm.in, fm.in, lp.in, sim.txt, qna.qna, cmp_sm.in, cmp_sim.sim."]]);
  });

  it("Export All asks finite networks for the convention first, and reports files not written as a warning", async () => {
    const report = { written: ["sim.txt"], summary: "Exported 1 solver input file(s) to /out: sim.txt. Blocking convention: Loss-network correction.", warning: "6 of 7 solver input files were not written.", warningDetail: "sm.in: a\nfm.in: b" };
    setup({ export_all_inputs: () => report }, { open: ["/out"] });
    setDocument(activeTab().id, exampleDoc("3d3cfin.bnet"));
    await act(() => runCommand("file:export-all"));
    const sheet = screen.getByRole("dialog", { name: "Export All Solver Inputs" });
    expect(sheet).toHaveTextContent("Writes every solver's input file into one folder — the same files Qnet --export-cmp produces.");
    expect(sheet).toHaveTextContent("Only sm.in, fm.in and lp.in depend on this choice; the QNA and simulator inputs are unaffected.");
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Blocking convention" }), { target: { value: "loss" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Choose Folder…" }));
    await waitFor(() => expect(log()).toHaveLength(4));
    expect(mockCalls.find((c) => c.cmd === "export_all_inputs")!.args).toMatchObject({ convention: "loss" });
    expect(log()).toEqual([
      ["success", report.summary],
      ["warning", "6 of 7 solver input files were not written."],
      ["info", "    sm.in: a"],
      ["info", "    fm.in: b"],
    ]);
  });
});

describe("Generate Random Network", () => {
  const lines = [
    { text: "Generated Random 3: d=4, c=3, infinite buffers, target ρ=0.90, topology=feed-forward." },
    { text: "Qnet-computed ρ:  S1=0.900  S2=0.880" },
    { text: "Banner WILL fire — warnings: 1" },
    { text: "  • station 2 has low utilization (ρ = 0.4000). The SRBM heavy-traffic approximation is most accurate when ρ is close to 1; results here may diverge from simulation." },
  ];

  it("opens the sheet with 0.90.34's fields and defaults (GEN-001…007)", async () => {
    setup();
    await act(() => runCommand("network:random"));
    const sheet = screen.getByRole("dialog", { name: "Generate Random Network" });
    expect(sheet).toHaveTextContent("Creates a random open network in a new tab: random routing per class, a random service law per (station, class) and arrival rates scaled to the target ρ.");
    expect(within(sheet).getByRole("textbox", { name: "Number of stations" })).toHaveValue("4");
    expect(within(sheet).getByRole("textbox", { name: "Number of customer classes" })).toHaveValue("3");
    const buffers = within(sheet).getByRole("combobox", { name: "Buffers" }) as HTMLSelectElement;
    expect([...buffers.options].map((o) => o.text)).toEqual(["Infinite", "Finite"]);
    expect(buffers.closest("[title]")).toHaveAttribute("title", "Infinite buffers give an SRBM on the orthant; finite buffers an SRBM on a hypercube");
    const topology = within(sheet).getByRole("combobox", { name: "Topology" }) as HTMLSelectElement;
    expect([...topology.options].map((o) => o.text)).toEqual(["Feed-forward", "Jackson feedback (light)", "General P-matrix (full feedback)", "Re-entrant feedback (class-change)"]);
    expect(within(sheet).getByRole("textbox", { name: "Target utilisation rho" })).toHaveValue("0.90");
    expect(within(sheet).getByRole("textbox", { name: "Random seed" })).toHaveAttribute("placeholder", "Random");
    expect(sheet).toHaveTextContent("a fixed seed regenerates the same network.");
    expect(modalOpen()).toBe(true);
    expect(reason("network:random")).toBe("Close the open dialog first");
  });

  it("shows the first blocking problem and disables Generate while there is one (GEN-002, GEN-003, GEN-006…008)", async () => {
    setup();
    await act(() => runCommand("network:random"));
    const sheet = screen.getByRole("dialog");
    const gen = within(sheet).getByRole("button", { name: "Generate" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Target utilisation rho" }), { target: { value: "1.2" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Number of stations" }), { target: { value: "21" } });
    expect(sheet).toHaveTextContent("Stations must be between 1 and 20.");
    expect(gen).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Decrease Number of stations" }));
    expect(sheet).toHaveTextContent("Target ρ must be a number between 0.10 and 0.99.");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Target utilisation rho" }), { target: { value: "0,95" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Random seed" }), { target: { value: "-3" } });
    expect(sheet).toHaveTextContent("Seed must be a non-negative integer, or blank for a random seed.");
    expect(sheet).toHaveTextContent("Enter a non-negative whole number");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Random seed" }), { target: { value: "18446744073709551615" } });
    expect(gen).toBeEnabled();
    expect(randomProblem({ ...RANDOM_DEFAULTS, classes: "9" })).toBe("Customer classes must be between 1 and 8.");
  });

  it("Return generates “Random N” in a new active tab, unsaved, with its Status lines (GEN-008…011, WS-033, WS-126)", async () => {
    let request: Record<string, unknown> | undefined;
    setup({ network_generate: ({ request: r }: { request: Record<string, unknown> }) => ((request = r), { text: JSON.stringify(exampleDoc()), lines }) });
    addTab({ title: "Random 2" }, { activate: false });
    addTab({ title: "Random x" }, { activate: false });
    await act(() => runCommand("network:random"));
    fireEvent.change(screen.getByRole("textbox", { name: "Random seed" }), { target: { value: " 42 " } });
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(request).toEqual({ stations: 4, classes: 3, infiniteBuffers: true, targetRho: 0.9, topology: "feedForward", seed: "42", title: "Random 3" });
    const t = activeTab();
    expect(t).toMatchObject({ title: "Random 3", path: null });
    expect(t.document.nodes).toHaveLength(exampleDoc().nodes.length);
    expect(isDirty(t)).toBe(true);
    expect(log(t)).toEqual([
      ["info", lines[0].text],
      ["info", lines[1].text],
      ["warning", lines[2].text],
      ["info", lines[3].text],
    ]);
    expect(modalOpen()).toBe(false);
  });

  it("numbers after the highest “Random N”, as 0.90.34 parsed it (GEN-009)", () => {
    expect(nextRandomTitle()).toBe("Random 1");
    addTab({ title: "Random 7" });
    addTab({ title: "Random +9" });
    addTab({ title: "Random 12a" });
    expect(nextRandomTitle()).toBe("Random 10");
  });

  it("parses ρ and the seed as 0.90.34's fields did", () => {
    expect(parseNumber(" 0.9 ")).toBe(0.9);
    expect(parseNumber("9e-1")).toBe(0.9);
    expect(parseNumber("0,95")).toBe(0.95);
    expect(parseNumber("abc")).toBeNull();
    expect(parseSeed("")).toBeUndefined();
    expect(parseSeed("+7")).toBe("7");
    expect(parseSeed("18446744073709551616")).toBeNull();
    expect(parseSeed("1.5")).toBeNull();
  });
});

describe("the File menu", () => {
  const fileItems = () => {
    const file = MENU_SPEC.find((e) => typeof e === "object" && "submenu" in e && e.submenu === "File") as { items: unknown[] };
    const ids: string[] = [];
    const walk = (items: unknown[]) => {
      for (const e of items) {
        if (e && typeof e === "object" && "id" in e) ids.push((e as { id: string }).id);
        if (e && typeof e === "object" && "items" in e) walk((e as { items: unknown[] }).items);
      }
    };
    walk(file.items);
    return ids;
  };

  it("holds only Qnet's own items, with no New Window and no Revert (MENU-008, MENU-018, WS-123)", () => {
    expect(fileItems()).toEqual([
      "file:new", "file:open", "file:clear-recent", "file:open-example", "file:new-from-archetype",
      "file:close-tab", "file:close-all-tabs", "file:close-window", "file:save", "file:save-as",
      "file:export-pdf", "file:export-png", "file:export-fbnasim", "file:export-srbm", "file:export-qna", "file:export-all", "file:export-status-log",
      "file:page-setup", "file:print",
    ]);
  });

  it("leaves New from Archetype… to the canvas phase: dimmed until then (MENU-014, GEN-043)", () => {
    setup();
    expect(getCommand("file:new-from-archetype")).toBeUndefined();
  });
});

describe("inferSeverity (0.90.34 StatusEntry.inferSeverity)", () => {
  it("reads the words as 0.90.34 did", () => {
    expect(inferSeverity("No warnings — banner should stay hidden.")).toBe("success");
    expect(inferSeverity("Banner WILL fire — warnings: 2")).toBe("warning");
    expect(inferSeverity("SRBMExporter failed on generated network: x")).toBe("error");
    expect(inferSeverity("  • station 1 is overloaded (ρ = 1.2000 ≥ 1). The network is unstable in the infinite-buffer sense")).toBe("warning");
    expect(inferSeverity("Loaded network with 3 nodes and 2 links.")).toBe("success");
    expect(inferSeverity("Generated Random 1: d=4")).toBe("info");
  });
});
