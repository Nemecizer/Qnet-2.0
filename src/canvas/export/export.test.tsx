// The diagram export against the mock backend (ledger §3.14, §8.11, MENU-022/023/030/031/037,
// SET-181…184): the figure's geometry, ground, legend band and snapshot rule; the options panel
// and its remembered answers; the commands' gating; and the PDF / PNG, Copy as Image, Print and
// Page Setup flows with 0.90.34's Status sentences. Rendering itself is Rust's
// (src-tauri/src/canvas_export.rs tests); the pasteboard and the Print panel are app checks.
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { diagramCalls, resetDiagramMock } from "../../dev/mock/export";
import { buildArchetypeDocument } from "../../dev/mock/archetypes";
import { getCommand, runCommand, unavailableReason } from "../../lib/commands";
import { getStateValue, setStateValues } from "../../lib/kv";
import { holdModal, modalOpen } from "../../lib/overlays";
import { activeEditor } from "../../editor";
import { activeTab, setDocument, updateTab } from "../../workspace/store";
import { mockTauri, type MockHandlers } from "../../test/tauri";
import { insertArchetype } from "../../windows/archetypes/insert";
import { DEFAULT_PARAMETERS } from "../../windows/archetypes/insert";
import { sceneContentRect } from "../geometry/scene";
import { canvasColors } from "../layers/colors";
import { useExportCommands } from "./commands";
import { closeExportPanel, confirmExport, exportDiagram, exportPanelState, resetExport } from "./export";
import { buildFigure, FIGURE_MARGIN, LEGEND_BAND, PAPER_WHITE } from "./figure";
import { DEFAULT_OPTIONS, EXPORT_KEYS, loadExportOptions, type ExportOptions } from "./options";
import { ExportOptionsForm, ExportPanelHost } from "./OptionsPanel";

afterEach(() => {
  resetExport();
  resetDiagramMock();
});

function Harness({ host }: { host: boolean }) {
  useExportCommands();
  return host ? <ExportPanelHost /> : null;
}

/** The mock backend, with the Save panel answering `save` in turn; returns the panels it showed. */
function setup(save: (string | null)[] = [], extra: MockHandlers = {}, host = false) {
  const panels: Record<string, unknown>[] = [];
  mockTauri({
    ...defaultHandlers(),
    "plugin:dialog|save": ({ options }: { options: Record<string, unknown> }) => {
      panels.push(options);
      return save.shift() ?? null;
    },
    ...extra,
  });
  render(<Harness host={host} />);
  return panels;
}

/** A Tandem Line on the active canvas (one class). */
function tandem(stations = 2) {
  let n = 0;
  const doc = buildArchetypeDocument({ kind: "tandemLine", ...DEFAULT_PARAMETERS, stations }, () => `T${++n}`);
  act(() => setDocument(activeTab().id, doc));
  return activeEditor();
}

/** Two Tandem Lines side by side: two sources, two classes. */
async function twoClasses() {
  const e = activeEditor();
  await act(async () => {
    await insertArchetype(e, "tandemLine", { stations: 1 });
    await Promise.resolve();
    await insertArchetype(e, "tandemLine", { stations: 1 });
    await Promise.resolve();
  });
  expect(e.numberOfCustomerClasses).toBe(2);
  return e;
}

const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_OPTIONS, ...o });
const log = () => activeTab().log.map((x) => [x.severity, x.text]);
const lastLog = () => log()[log().length - 1];
const reason = (id: string) => unavailableReason(getCommand(id)!);
const parse = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");

describe("the figure (CAN-185…188, FILE-059/060)", () => {
  it("is the zoom-1 content rect plus a 24 pt margin, with a 32 pt band only for a legend of 2+ classes", async () => {
    setup();
    const e = tandem();
    const content = sceneContentRect(e.nodes, e.links, e.routePlan)!;
    const f = buildFigure(e, { options: opts(), opaqueFallback: false })!;
    expect(f.width).toBeCloseTo(content.width + 2 * FIGURE_MARGIN);
    expect(f.height).toBeCloseTo(content.height + 2 * FIGURE_MARGIN);
    const svg = parse(f.svg).documentElement;
    expect(svg.getAttribute("width")).toBe(String(Math.round(f.width * 1000) / 1000));
    expect(f.svg).not.toContain("data-layer=\"legend\"");

    act(() => setDocument(activeTab().id, { ...activeTab().document, nodes: [], links: [] }));
    const two = await twoClasses();
    const c2 = sceneContentRect(two.nodes, two.links, two.routePlan)!;
    const withLegend = buildFigure(two, { options: opts(), opaqueFallback: false })!;
    expect(withLegend.height).toBeCloseTo(c2.height + 2 * FIGURE_MARGIN + LEGEND_BAND);
    const chips = parse(withLegend.svg).querySelectorAll("[data-legend-chip]");
    expect([...chips].map((c) => c.textContent)).toEqual(["Class 1", "Class 2"]);
    const noLegend = buildFigure(two, { options: opts({ includesLegend: false }), opaqueFallback: false })!;
    expect(noLegend.height).toBeCloseTo(c2.height + 2 * FIGURE_MARGIN);
  });

  it("stands alone: well-formed SVG with resolved colours, no CSS variables", () => {
    setup();
    const f = buildFigure(tandem(), { options: opts({ includesGrid: true }), opaqueFallback: false })!;
    expect(f.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(parse(f.svg).querySelector("parsererror")).toBeNull();
    expect(f.svg).not.toMatch(/var\(/);
    expect(f.svg).not.toMatch(/currentColor/);
  });

  it("draws on the light canvas ground, paper white, or nothing — a transparent ground turns white where alpha can't go", () => {
    setup();
    const e = tandem();
    const ground = (o: Partial<ExportOptions>, opaque: boolean) => parse(buildFigure(e, { options: opts(o), opaqueFallback: opaque })!.svg).querySelector('[data-layer="ground"]')?.getAttribute("fill") ?? null;
    expect(ground({ background: "canvas" }, false)).toBe(canvasColors("light").background);
    expect(ground({ background: "white" }, false)).toBe(PAPER_WHITE);
    expect(ground({ background: "transparent" }, false)).toBeNull();
    expect(ground({ background: "transparent" }, true)).toBe(PAPER_WHITE);
  });

  it("is a snapshot: the selection, hover and a pending link don't change it", () => {
    setup();
    const e = tandem();
    const before = buildFigure(e, { options: opts(), opaqueFallback: false })!.svg;
    act(() => {
      e.setNodeSelection(new Set(e.nodes.slice(0, 2).map((n) => n.id)));
      e.setView({ hoveredNodeID: e.nodes[2].id, hoveredLinkID: e.links[0].id });
    });
    expect(buildFigure(e, { options: opts(), opaqueFallback: false })!.svg).toBe(before);
  });

  it("of a selection holds only its nodes and the links between them", () => {
    setup();
    const e = tandem(2);
    const [src, b1, s1] = e.nodes;
    const f = buildFigure(e, { options: opts(), only: new Set([src.id, b1.id, s1.id]), opaqueFallback: false })!;
    expect(f.isSelection).toBe(true);
    expect(f.nodeCount).toBe(3);
    const all = buildFigure(e, { options: opts(), opaqueFallback: false })!;
    expect(f.width).toBeLessThan(all.width);
    expect(f.svg).toContain(">S1<");
    expect(f.svg).not.toContain(">S2<");
  });

  it("follows the canvas's class filter while the legend lists every class (CAN-187)", async () => {
    setup();
    const e = await twoClasses();
    act(() => e.setView({ classFilter: 1 }));
    const f = buildFigure(e, { options: opts(), opaqueFallback: false })!;
    const unfiltered = (() => {
      e.setView({ classFilter: null });
      return buildFigure(e, { options: opts(), opaqueFallback: false })!;
    })();
    expect(f.svg.length).toBeLessThan(unfiltered.svg.length);
    expect(parse(f.svg).querySelectorAll("[data-legend-chip]")).toHaveLength(2);
  });
});

describe("the remembered options (SET-181…184, FILE-058)", () => {
  it("default to 2×, Canvas, no grid, legend on, and keep only valid stored values", async () => {
    setup();
    expect(loadExportOptions()).toEqual({ pixelScale: 2, background: "canvas", includesGrid: false, includesLegend: true });
    await setStateValues({ [EXPORT_KEYS.pixelScale]: 4, [EXPORT_KEYS.background]: "transparent", [EXPORT_KEYS.includesGrid]: true, [EXPORT_KEYS.includesLegend]: false });
    expect(loadExportOptions()).toEqual({ pixelScale: 4, background: "transparent", includesGrid: true, includesLegend: false });
    await setStateValues({ [EXPORT_KEYS.pixelScale]: 3, [EXPORT_KEYS.background]: "paper" });
    expect(loadExportOptions()).toMatchObject({ pixelScale: 2, background: "canvas" });
  });
});

describe("the options panel (CAN-192…196)", () => {
  it("asks for a PDF's background (three choices), grid and legend, in 0.90.34's words", () => {
    setup();
    render(<ExportOptionsForm format="pdf" classCount={1} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("heading", { name: "Export Diagram as PDF" })).toBeInTheDocument();
    expect(screen.getByText("Vector output — resolution-independent at any size, for a paper figure or a slide.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Scale" })).toBeNull();
    const bg = screen.getByRole("radiogroup", { name: "Background" });
    expect(within(bg).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Canvas", "White", "Transparent"]);
    expect(within(bg).getByRole("radio", { name: "Canvas" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Include grid" })).not.toBeChecked();
    const legend = screen.getByRole("checkbox", { name: "Include class legend" });
    expect(legend).toBeChecked();
    expect(legend).toBeDisabled();
    expect(screen.getByText("Every export is drawn in the light appearance, so a figure made at midnight matches one made at noon.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled();
  });

  it("asks a PNG's scale (1×, 2×, 4×) and offers Canvas or White, and names the classes in the footer", () => {
    setup();
    render(<ExportOptionsForm format="png" classCount={3} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("heading", { name: "Export Diagram as PNG" })).toBeInTheDocument();
    const scale = screen.getByRole("radiogroup", { name: "Scale" });
    expect(within(scale).getAllByRole("radio").map((r) => r.textContent)).toEqual(["1×", "2×", "4×"]);
    expect(within(scale).getByRole("radio", { name: "2×" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "Background" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Canvas", "White"]);
    expect(screen.getByRole("checkbox", { name: "Include class legend" })).toBeEnabled();
    expect(screen.getByText(/This network has 3 customer classes; a figure without its colour key is hard to read in print\./)).toBeInTheDocument();
  });

  it("remembers every answer the moment it changes, and Export… hands them on; Escape cancels, Return confirms", async () => {
    setup();
    const confirmed: ExportOptions[] = [];
    let cancelled = 0;
    render(<ExportOptionsForm format="png" classCount={2} onCancel={() => cancelled++} onConfirm={(o) => confirmed.push(o)} />);
    fireEvent.click(screen.getByRole("radio", { name: "4×" }));
    fireEvent.click(screen.getByRole("radio", { name: "White" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include grid" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include class legend" }));
    expect(getStateValue(EXPORT_KEYS.pixelScale, null)).toBe(4);
    expect(getStateValue(EXPORT_KEYS.background, null)).toBe("white");
    expect(getStateValue(EXPORT_KEYS.includesGrid, null)).toBe(true);
    expect(getStateValue(EXPORT_KEYS.includesLegend, null)).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(confirmed).toEqual([{ pixelScale: 4, background: "white", includesGrid: true, includesLegend: false }]);
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Include grid" }), { key: "Escape" });
    expect(cancelled).toBe(1);
    await act(async () => fireEvent.keyDown(screen.getByRole("radio", { name: "4×" }).closest("[data-panel]")!, { key: "Enter" }));
    expect(confirmed).toHaveLength(2);
  });

  it("opens as one modeless panel 'canvas-export', rebuilt when the other format is asked for", () => {
    setup([], {}, true);
    tandem();
    const opened: string[] = [];
    const frames: HTMLIFrameElement[] = [];
    const real = window.open;
    window.open = ((_url: string, name: string) => {
      opened.push(name);
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      frames.push(f);
      return f.contentWindow;
    }) as typeof window.open;
    try {
      act(() => void runCommand("file:export-pdf"));
      expect(opened).toEqual(["qnet-panel-canvas-export"]);
      expect(modalOpen()).toBe(false);
      expect(within(frames[0].contentDocument!.body).getByRole("heading", { name: "Export Diagram as PDF" })).toBeInTheDocument();
      act(() => void runCommand("file:export-png"));
      expect(opened).toEqual(["qnet-panel-canvas-export", "qnet-panel-canvas-export"]);
      expect(within(frames[1].contentDocument!.body).getByRole("heading", { name: "Export Diagram as PNG" })).toBeInTheDocument();
      act(() => closeExportPanel());
    } finally {
      window.open = real;
      frames.forEach((f) => f.remove());
    }
  });
});

describe("the commands' gating (MENU-022/023/030/031/037)", () => {
  it("are dimmed with no network and while a sheet is up; Page Setup only under a sheet", () => {
    setup();
    for (const id of ["file:export-pdf", "file:export-png", "edit:copy-as-image", "file:print"]) expect(reason(id)).toBe("Draw or open a network first");
    expect(reason("file:page-setup")).toBeNull();
    tandem();
    for (const id of ["file:export-pdf", "file:export-png", "edit:copy-as-image", "file:print", "file:page-setup"]) expect(reason(id)).toBeNull();
    const release = holdModal();
    for (const id of ["file:export-pdf", "file:export-png", "edit:copy-as-image", "file:print", "file:page-setup"]) expect(reason(id)).toBe("Close the open dialog first");
    release();
  });

  it("an empty canvas logs 0.90.34's warnings and opens nothing (CAN-191, FILE-061)", async () => {
    setup();
    act(() => exportDiagram("pdf"));
    expect(exportPanelState()).toBeNull();
    expect(lastLog()).toEqual(["warning", "Nothing to export: the canvas is empty."]);
    const { copyAsImage, printDiagram } = await import("./export");
    await act(() => copyAsImage());
    expect(lastLog()).toEqual(["warning", "Nothing to copy: the canvas is empty."]);
    await act(() => printDiagram());
    expect(lastLog()).toEqual(["warning", "Nothing to print: the canvas is empty."]);
    expect(diagramCalls).toHaveLength(0);
  });
});

describe("export to a file (CAN-189…191, FILE-057, FILE-061)", () => {
  it("PDF: the panel, then 'Export Diagram' with '<document>.pdf', then the vector figure on its own ground", async () => {
    const panels = setup(["/tmp/figs/tandem.pdf"]);
    tandem();
    act(() => updateTab(activeTab().id, { path: "/Users/me/nets/tandem.bnet" }));
    act(() => exportDiagram("pdf"));
    const state = exportPanelState()!;
    expect(state).toMatchObject({ format: "pdf", classCount: 1 });
    await act(() => confirmExport(state, opts({ background: "transparent" })));
    expect(exportPanelState()).toBeNull();
    expect(panels[0]).toMatchObject({ title: "Export Diagram", defaultPath: "tandem.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    const call = diagramCalls.find((c) => c.cmd === "diagram_export")!;
    expect(call.args).toMatchObject({ format: "pdf", path: "/tmp/figs/tandem.pdf" });
    expect(String(call.args.svg)).not.toContain('data-layer="ground"');
    expect(lastLog()).toEqual(["success", "Exported diagram to tandem.pdf."]);
  });

  it("PNG: 'Network Diagram.png' for an untitled tab, at the chosen scale, a transparent choice on white", async () => {
    const panels = setup(["/tmp/Network Diagram.png"]);
    tandem();
    act(() => exportDiagram("png"));
    await act(() => confirmExport(exportPanelState()!, opts({ pixelScale: 4, background: "transparent" })));
    expect(panels[0]).toMatchObject({ defaultPath: "Network Diagram.png" });
    const call = diagramCalls.find((c) => c.cmd === "diagram_export")!;
    expect(call.args).toMatchObject({ format: "png", scale: 4 });
    expect(String(call.args.svg)).toContain(`data-layer="ground" x="0" y="0"`);
    expect(String(call.args.svg)).toContain(`fill="${PAPER_WHITE}"`);
    expect(lastLog()).toEqual(["success", "Exported diagram to Network Diagram.png."]);
  });

  it("a cancelled Save panel writes nothing; a write failure and a render failure log 0.90.34's errors", async () => {
    setup([null, "/read-only/x.pdf", "/tmp/y.pdf"], {});
    tandem();
    act(() => exportDiagram("pdf"));
    expect(await act(() => confirmExport(exportPanelState() ?? { format: "pdf", tabId: activeTab().id, classCount: 1, seq: 0 }, opts()))).toBe(false);
    expect(diagramCalls).toHaveLength(0);
    await act(() => confirmExport({ format: "pdf", tabId: activeTab().id, classCount: 1, seq: 0 }, opts()));
    expect(lastLog()).toEqual(["error", "!! Could not write x.pdf: Permission denied (os error 13)"]);
    mockTauri({
      ...defaultHandlers(),
      "plugin:dialog|save": () => "/tmp/y.pdf",
      diagram_export: () => {
        throw { kind: "invalid", message: "Qnet couldn't render the diagram." };
      },
    });
    await act(() => confirmExport({ format: "pdf", tabId: activeTab().id, classCount: 1, seq: 0 }, opts()));
    expect(lastLog()).toEqual(["error", "!! Could not render the diagram for export."]);
  });
});

describe("Copy as Image, Print Diagram and Page Setup (CAN-197…199, FILE-062/063)", () => {
  it("copies the selection and the links inside it, or the whole diagram, as PDF and TIFF with the remembered options", async () => {
    setup();
    const e = tandem(2);
    await setStateValues({ [EXPORT_KEYS.pixelScale]: 1, [EXPORT_KEYS.background]: "transparent" });
    await act(() => runCommand("edit:copy-as-image"));
    expect(lastLog()).toEqual(["info", "Copied the diagram to the clipboard as PDF and TIFF."]);
    const whole = diagramCalls.find((c) => c.cmd === "diagram_copy")!;
    expect(whole.args.scale).toBe(1);
    expect(String(whole.args.pdfSvg)).not.toContain('data-layer="ground"');
    expect(String(whole.args.imageSvg)).toContain(`fill="${PAPER_WHITE}"`);
    act(() => e.setNodeSelection(new Set([e.nodes[1].id, e.nodes[2].id])));
    await act(() => runCommand("edit:copy-as-image"));
    expect(lastLog()).toEqual(["info", "Copied 2 selected nodes and the links between them to the clipboard as PDF and TIFF."]);
    act(() => e.setNodeSelection(new Set([e.nodes[1].id])));
    await act(() => runCommand("edit:copy-as-image"));
    expect(lastLog()).toEqual(["info", "Copied 1 selected node and the links between them to the clipboard as PDF and TIFF."]);
  });

  it("a pasteboard failure logs 0.90.34's error", async () => {
    setup([], { diagram_copy: () => Promise.reject({ kind: "failed", message: "The pasteboard refused the diagram." }) });
    tandem();
    await act(() => runCommand("edit:copy-as-image"));
    expect(lastLog()).toEqual(["error", "!! Could not render the diagram for the clipboard."]);
  });

  it("prints the vector page with the document's name as the job title, the canvas ground left off, modal while up", async () => {
    let wasModal = false;
    setup([], {
      diagram_print: (args: { svg: string; jobTitle: string }) => {
        wasModal = modalOpen();
        diagramCalls.push({ cmd: "diagram_print", args });
        return null;
      },
    });
    tandem();
    act(() => updateTab(activeTab().id, { path: "/n/line.bnet" }));
    await act(() => runCommand("file:print"));
    const call = diagramCalls.find((c) => c.cmd === "diagram_print")!;
    expect(call.args.jobTitle).toBe("line");
    expect(String(call.args.svg)).not.toContain('data-layer="ground"');
    expect(wasModal).toBe(true);
    expect(modalOpen()).toBe(false);
  });

  it("Page Setup runs AppKit's panel, modal while up", async () => {
    let wasModal = false;
    setup([], {
      diagram_page_setup: () => {
        wasModal = modalOpen();
        return null;
      },
    });
    await act(() => runCommand("file:page-setup"));
    expect(wasModal).toBe(true);
  });
});
