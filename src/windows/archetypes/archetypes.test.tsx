// The archetype gallery against the mock backend (ledger §14.7 GEN-042…051, MENU-014, MENU-100):
// validation, the insert note, the keyboard walk and the schematic, the form in 0.90.34's words,
// and Insert as one undo step. The builder itself is checked in builder.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { buildArchetypeDocument } from "../../dev/mock/archetypes";
import { getCommand, runCommand, unavailableReason } from "../../lib/commands";
import { modalOpen } from "../../lib/overlays";
import { activeEditor } from "../../editor";
import { activeTab } from "../../workspace/store";
import { mockTauri } from "../../test/tauri";
import { useNetworkCommands } from "../../network";
import { ArchetypeGalleryForm, ArchetypeGalleryHost } from "./Gallery";
import { DEFAULT_PARAMETERS, insertArchetype } from "./insert";
import { closeArchetypeGallery, galleryProblem, galleryRequest, galleryState, initialForm, insertFromGallery, insertNote, moveHighlight, openArchetypeGallery, resetGallery, schematicOf, type GalleryForm } from "./state";

afterEach(() => resetGallery());

const tile = () => within(screen.getByRole("listbox", { name: "Insert Archetype" })).getByRole("option", { selected: true });
const form = (patch: Partial<GalleryForm> = {}): GalleryForm => ({ ...initialForm(true), ...patch });
const log = () => activeTab().log.map((x) => x.text);
const lastLog = () => log()[log().length - 1];

function Harness({ host }: { host?: boolean }) {
  useNetworkCommands();
  return host ? <ArchetypeGalleryHost /> : null;
}

function setup(host = false) {
  mockTauri(defaultHandlers());
  render(<Harness host={host} />);
}

describe("the gallery's rules", () => {
  it("reports the first blocking problem in the order the fields are read, only for the knobs the archetype uses (GEN-050)", () => {
    expect(galleryProblem(form())).toBeNull();
    expect(galleryProblem(form({ stations: "13" }))).toBe("Stations must be between 1 and 12.");
    expect(galleryProblem(form({ stations: "13", highlighted: "mmcStation" }))).toBeNull();
    expect(galleryProblem(form({ servers: "0", lambda: "x" }))).toBe("Servers must be between 1 and 16.");
    expect(galleryProblem(form({ lambda: "0", rho: "2" }))).toBe("Arrival rate λ must be a positive number.");
    expect(galleryProblem(form({ rho: "0.999" }))).toBe("Target ρ must be a number between 0.05 and 0.99.");
    expect(galleryProblem(form({ rho: "0,5" }))).toBeNull();
    expect(galleryProblem(form({ feedback: "0.95" }))).toBeNull();
    expect(galleryProblem(form({ feedback: "0.95", highlighted: "openJacksonFeedback" }))).toBe("Feedback probability p must be a number between 0.00 and 0.90.");
    expect(galleryProblem(form({ capacity: "501" }))).toBeNull();
    expect(galleryProblem(form({ capacity: "501", infiniteBuffers: false }))).toBe("Buffer capacity must be between 1 and 500.");
  });

  it("falls back to the defaults for a field that doesn't parse, so the summary never goes blank", () => {
    expect(galleryRequest(form({ rho: "x", stations: "", lambda: "2.5" }))).toEqual({ kind: "tandemLine", ...DEFAULT_PARAMETERS, arrivalRate: 2.5 });
  });

  it("says what the insert will do to the canvas (GEN-049)", () => {
    const empty = { canvasNodeCount: 0, canvasSourceCount: 0, initialInfiniteBuffers: true };
    expect(insertNote(form(), empty)).toBe("The buffer model is network-wide. This canvas is empty, so the choice above becomes the whole network's: the insert will put it on infinite buffers.");
    expect(insertNote(form({ infiniteBuffers: false }), empty)).toContain("the insert will put it on finite buffers.");
    const one = { canvasNodeCount: 1, canvasSourceCount: 0, initialInfiniteBuffers: true };
    expect(insertNote(form(), one)).toBe("The archetype is inserted clear to the right of the 1 node already on the canvas, with its own numbering continued.");
    const busy = { canvasNodeCount: 8, canvasSourceCount: 1, initialInfiniteBuffers: false };
    expect(insertNote(form({ infiniteBuffers: true }), busy)).toBe(
      "The archetype is inserted clear to the right of the 8 nodes already on the canvas, with its own numbering continued. Its source becomes Class 2, and the links inserted with it are moved onto that class. The two blocks share no station, so a second class does not cost the analysis its exactness — a link drawn between them later is what would make the document genuinely multi-class. The canvas is on finite buffers and an insert does not re-interpret the stations already there, so the network stays on finite buffers — Network ▸ Buffer Model changes it for the whole network.",
    );
  });

  it("walks the catalogue with the arrow keys, clamped at the ends (GEN-046)", () => {
    expect(moveHighlight("tandemLine", -1)).toBe("mmcStation");
    expect(moveHighlight("mmcStation", -1)).toBe("mmcStation");
    expect(moveHighlight("tandemLine", 1)).toBe("forkStyleSplit");
    expect(moveHighlight("reentrantTwoStation", 1)).toBe("reentrantTwoStation");
  });

  it("draws each tile from the built network in the unit square, with loops and returning arcs told apart (GEN-042)", () => {
    let n = 0;
    const rework = schematicOf(buildArchetypeDocument({ kind: "openJacksonFeedback", ...DEFAULT_PARAMETERS }, () => `r${++n}`));
    expect(rework.markers).toHaveLength(8);
    expect(rework.markers.every((m) => m.x >= 0 && m.x <= 1 && m.y === 0.5)).toBe(true);
    // Rework arcs go station → its own buffer, upstream: drawn as returning arcs.
    expect(rework.edges.filter((e) => e.isBackward)).toHaveLength(3);
    const fork = schematicOf(buildArchetypeDocument({ kind: "forkStyleSplit", ...DEFAULT_PARAMETERS }, () => `f${++n}`));
    expect(new Set(fork.markers.map((m) => m.y))).toEqual(new Set([0, 0.5, 1]));
    expect(fork.edges.some((e) => e.isBackward)).toBe(false);
  });
});

describe("the gallery form (GEN-045…048, GEN-050)", () => {
  const show = (state = { canvasNodeCount: 0, canvasSourceCount: 0, initialInfiniteBuffers: true }, onInsert = (_f: GalleryForm, _k: string) => {}) => {
    mockTauri(defaultHandlers());
    render(<ArchetypeGalleryForm state={state} onCancel={() => {}} onInsert={onInsert} />);
  };

  it("opens on Tandem Line with 0.90.34's sections, knobs and summary", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Insert Archetype" })).toBeInTheDocument();
    expect(screen.getByText("Pick a starting network and set its size and load. It is inserted into the current canvas as one undoable step, already laid out and ready to run.")).toBeInTheDocument();
    const groups = within(screen.getByRole("listbox", { name: "Insert Archetype" })).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Single Station", "Lines", "Feedback"]);
    expect(tile()).toHaveAttribute("data-archetype", "tandemLine");
    expect(tile()).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Number of stations" })).toHaveValue("3");
    expect(screen.getByRole("textbox", { name: "Servers per station" })).toHaveValue("1");
    expect(screen.getByRole("textbox", { name: "External arrival rate lambda" })).toHaveValue("1.0");
    expect(screen.getByRole("textbox", { name: "Target utilisation rho" })).toHaveValue("0.90");
    expect(screen.queryByRole("textbox", { name: "Feedback probability p" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Buffers" })).toHaveDisplayValue("Infinite");
    expect(screen.queryByRole("textbox", { name: "Buffer capacity" })).toBeNull();
    expect(screen.getByText("λ and ρ fix the service rates: μ = α / (ρ · c) at every station, where α is the throughput the traffic equations give.")).toBeInTheDocument();
    expect(await screen.findByLabelText("Will insert: 3 stations, 8 nodes, 7 links, λ = 1.000, ρ = 0.900 at every station")).toBeInTheDocument();
  });

  it("shows only the knobs the highlighted archetype uses, and the arrow keys move the highlight", async () => {
    show();
    fireEvent.click(screen.getByRole("option", { name: /^M\/M\/c Station\./ }));
    expect(screen.queryByRole("textbox", { name: "Number of stations" })).toBeNull();
    expect(await screen.findByLabelText("Will insert: 1 station, 4 nodes, 3 links, λ = 1.000, ρ = 0.900 at every station")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowRight" });
    expect(tile()).toHaveAttribute("data-archetype", "openJacksonFeedback");
    expect(screen.getByRole("textbox", { name: "Feedback probability p" })).toHaveValue("0.30");
    fireEvent.change(screen.getByRole("combobox", { name: "Buffers" }), { target: { value: "finite" } });
    expect(screen.getByRole("textbox", { name: "Buffer capacity" })).toHaveValue("10");
  });

  it("blocks Insert with the first problem, and Insert / Return / a double click hand the form on", async () => {
    const inserted: string[] = [];
    show(undefined, (_f, k) => void inserted.push(k));
    fireEvent.change(screen.getByRole("textbox", { name: "Target utilisation rho" }), { target: { value: "1.5" } });
    expect(screen.getByRole("status")).toHaveTextContent("Target ρ must be a number between 0.05 and 0.99.");
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
    fireEvent.doubleClick(screen.getByRole("option", { name: /^Fork and Merge\./ }));
    expect(inserted).toEqual([]);
    fireEvent.change(screen.getByRole("textbox", { name: "Target utilisation rho" }), { target: { value: "0.8" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Insert" })));
    await act(async () => fireEvent.doubleClick(screen.getByRole("option", { name: /^Fork and Merge\./ })));
    await act(async () => fireEvent.keyDown(tile(), { key: "Enter" }));
    expect(inserted).toEqual(["tandemLine", "forkStyleSplit", "tandemLine"]);
  });
});

describe("Insert (GEN-051, CAN-184)", () => {
  it("on an empty canvas: one undo step 'Insert Tandem Line', the regime adopted, 0.90.34's status line", async () => {
    setup();
    const e = activeEditor();
    act(() => openArchetypeGallery());
    const state = galleryState()!;
    expect(state).toMatchObject({ canvasNodeCount: 0, initialInfiniteBuffers: true });
    await act(async () => {
      await insertFromGallery(state.tabId, form({ stations: "2" }));
      await Promise.resolve();
    });
    expect(galleryState()).toBeNull();
    expect(e.nodes.map((n) => n.name)).toEqual(["Src1", "B1", "S1", "B2", "S2", "Sink1"]);
    expect(e.nodes[0].position).toEqual([80, 220]);
    expect(e.infiniteBuffers).toBe(true);
    expect(e.undoManager.undoActionName).toBe("Insert Tandem Line");
    expect(lastLog()).toBe("Insert Tandem Line: added 6 nodes and 5 links. 2 stations, 6 nodes, 5 links, λ = 1.000, ρ = 0.900 at every station.");
    act(() => e.undo());
    expect(e.nodes).toHaveLength(0);
  });

  it("beside a network: continued numbering, the next class, the document's regime kept", async () => {
    setup();
    const e = activeEditor();
    await act(async () => {
      await insertArchetype(e, "mmcStation", {});
      await Promise.resolve();
    });
    act(() => openArchetypeGallery());
    expect(galleryState()).toMatchObject({ canvasNodeCount: 4, canvasSourceCount: 1, initialInfiniteBuffers: true });
    await act(async () => {
      await insertFromGallery(galleryState()!.tabId, form({ infiniteBuffers: false, capacity: "4" }), "reentrantTwoStation");
      await Promise.resolve();
    });
    expect(e.nodes.map((n) => n.name)).toEqual(["Src1", "B1", "S1", "Sink1", "Src2", "B2", "S2", "B3", "S3", "Sink2"]);
    expect(e.infiniteBuffers).toBe(true);
    expect(e.numberOfCustomerClasses).toBe(2);
    expect(e.undoManager.undoActionName).toBe("Insert Re-entrant Pair");
    expect(lastLog()).toContain("The network stays on infinite buffers — an insert never re-interprets the stations already on the canvas.");
    expect(lastLog()).toContain("Its traffic is Class 2, because the canvas already had a source.");
  });
});

describe("the commands (MENU-014, MENU-100, GEN-043, GEN-044)", () => {
  it("New from Archetype and Insert Archetype open one document-modal gallery; asking again brings it forward", () => {
    setup(true);
    const opened: string[] = [];
    const frames: HTMLIFrameElement[] = [];
    const real = window.open;
    window.open = ((_u: string, name: string) => {
      opened.push(name);
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      frames.push(f);
      return f.contentWindow;
    }) as typeof window.open;
    try {
      expect(unavailableReason(getCommand("network:insert-archetype")!)).toBeNull();
      act(() => void runCommand("network:insert-archetype"));
      expect(opened).toEqual(["qnet-panel-archetype-gallery"]);
      expect(modalOpen()).toBe(true);
      expect(within(frames[0].contentDocument!.body).getByRole("heading", { name: "Insert Archetype" })).toBeInTheDocument();
      // The gallery counts as a sheet: Insert Archetype… dims, New from Archetype… doesn't.
      expect(unavailableReason(getCommand("network:insert-archetype")!)).toBe("Close the open dialog first");
      expect(unavailableReason(getCommand("file:new-from-archetype")!)).toBeNull();
      act(() => void runCommand("file:new-from-archetype"));
      expect(opened).toHaveLength(1);
      act(() => closeArchetypeGallery());
      expect(modalOpen()).toBe(false);
    } finally {
      window.open = real;
      frames.forEach((f) => f.remove());
    }
  });

  it("opens Buffers on the document's regime when the canvas has nodes (GEN-048)", async () => {
    setup();
    const e = activeEditor();
    await act(async () => {
      await insertArchetype(e, "mmcStation", { infiniteBuffers: false });
      await Promise.resolve();
    });
    act(() => openArchetypeGallery());
    expect(galleryState()!.initialInfiniteBuffers).toBe(false);
    await waitFor(() => expect(e.infiniteBuffers).toBe(false));
  });
});
