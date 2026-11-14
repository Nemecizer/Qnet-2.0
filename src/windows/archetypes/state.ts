// The archetype gallery's state and rules (0.90.34 ArchetypeGallerySheet.swift `problem`,
// `parameters`, `insertNote`, `move(by:)`; QnetGUIApp.swift `insertArchetype`,
// `syncArchetypePanel`; ledger GEN-043…051). The network itself is built in Rust by core's port
// of `NetworkArchetypeBuilder` (src-tauri/src/archetypes.rs) and inserted with
// `editor.insertSubnetwork` as one undo step named "Insert <title>".
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { raiseAuxWindow } from "../../lib/auxWindow";
import { parseDocument, type BnetDocument } from "../../lib/bnet";
import { report } from "../../lib/dialogs";
import type { ArchetypeRequest } from "../../lib/types";
import { activeEditor, editorFor } from "../../editor";
import { tabById } from "../../workspace/store";
import { parseNumber, parseWhole } from "../../workspace/files/generate";
import { BLUEPRINTS, blueprint, DEFAULT_ARCHETYPE, RANGES, uses, type ArchetypeKind } from "./catalogue";
import { insertArchetype } from "./insert";
import { archetypeWords as w } from "./words";

export const GALLERY_PANEL_ID = "archetype-gallery";

// ── The panel: open for one canvas, with what it needs to know about that canvas ────────────

export interface GalleryPanelState {
  tabId: string;
  canvasNodeCount: number;
  canvasSourceCount: number;
  /** The regime the Buffers control opens on: Infinite on an empty canvas, the document's otherwise. */
  initialInfiniteBuffers: boolean;
  seq: number;
}

let panel: GalleryPanelState | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export function galleryState(): GalleryPanelState | null {
  return panel;
}

export function useGalleryPanel(): GalleryPanelState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => panel,
  );
}

/**
 * File ▸ New from Archetype…, Network ▸ Insert Archetype… and the empty canvas's "Start from an
 * Archetype…": opens the gallery for the active canvas, or brings it forward when it is up.
 */
export function openArchetypeGallery() {
  if (panel) {
    if (raiseAuxWindow(`panel-${GALLERY_PANEL_ID}`)) return;
    // A standing request with no window behind it: present again rather than do nothing.
  }
  const e = activeEditor();
  const empty = e.nodes.length === 0;
  panel = {
    tabId: e.tabId,
    canvasNodeCount: e.nodes.length,
    canvasSourceCount: e.nodes.filter((n) => n.kind === "source").length,
    initialInfiniteBuffers: empty ? true : e.infiniteBuffers,
    seq: ++seq,
  };
  publish();
}

export function closeArchetypeGallery() {
  if (!panel) return;
  panel = null;
  publish();
}

// ── The form ──────────────────────────────────────────────────────────────────────────────

export interface GalleryForm {
  highlighted: ArchetypeKind;
  stations: string;
  servers: string;
  capacity: string;
  infiniteBuffers: boolean;
  rho: string;
  feedback: string;
  lambda: string;
}

export function initialForm(initialInfiniteBuffers: boolean): GalleryForm {
  return { highlighted: DEFAULT_ARCHETYPE, stations: "3", servers: "1", capacity: "10", infiniteBuffers: initialInfiniteBuffers, rho: "0.90", feedback: "0.30", lambda: "1.0" };
}

const within = (v: number | null, [lo, hi]: readonly [number, number]) => v !== null && Number.isFinite(v) && v >= lo && v <= hi;

const rhoValue = (f: GalleryForm) => {
  const v = parseNumber(f.rho);
  return within(v, RANGES.rho) ? v : null;
};
const feedbackValue = (f: GalleryForm) => {
  const v = parseNumber(f.feedback);
  return within(v, RANGES.feedback) ? v : null;
};
const lambdaValue = (f: GalleryForm) => {
  const v = parseNumber(f.lambda);
  return within(v, RANGES.arrivalRate) ? v : null;
};

/** The first blocking problem, in the order the fields are read, or null. */
export function galleryProblem(f: GalleryForm): string | null {
  const b = blueprint(f.highlighted);
  if (uses(b, "stations") && !within(parseWhole(f.stations), RANGES.stations)) return w.stationsProblem;
  if (uses(b, "servers") && !within(parseWhole(f.servers), RANGES.servers)) return w.serversProblem;
  if (uses(b, "arrivalRate") && lambdaValue(f) === null) return w.lambdaProblem;
  if (uses(b, "targetRho") && rhoValue(f) === null) return w.rhoProblem;
  if (uses(b, "feedbackProbability") && feedbackValue(f) === null) return w.feedbackProblem;
  if (uses(b, "buffers") && !f.infiniteBuffers && !within(parseWhole(f.capacity), RANGES.capacity)) return w.capacityProblem;
  return null;
}

/** The parameters as they stand; a field that doesn't parse falls back to its default, so the summary never goes blank. */
export function galleryRequest(f: GalleryForm, kind: ArchetypeKind = f.highlighted): ArchetypeRequest {
  const int = (t: string, d: number) => parseWhole(t) ?? d;
  return {
    kind,
    stations: int(f.stations, 3),
    servers: int(f.servers, 1),
    bufferCapacity: int(f.capacity, 10),
    infiniteBuffers: f.infiniteBuffers,
    targetRho: rhoValue(f) ?? 0.9,
    feedbackProbability: feedbackValue(f) ?? 0.3,
    arrivalRate: lambdaValue(f) ?? 1.0,
  };
}

/** What the insert will do to the network already there (0.90.34 `insertNote`). */
export function insertNote(f: GalleryForm, p: Pick<GalleryPanelState, "canvasNodeCount" | "canvasSourceCount" | "initialInfiniteBuffers">): string {
  if (p.canvasNodeCount <= 0) return w.emptyNote(f.infiniteBuffers);
  let note = w.besideNote(p.canvasNodeCount);
  if (p.canvasSourceCount > 0) note += w.classNote(w.classLabel(p.canvasSourceCount)) + w.exactNote;
  if (f.infiniteBuffers !== p.initialInfiniteBuffers) note += w.regimeNote(p.initialInfiniteBuffers);
  return note;
}

const FLAT_ORDER: readonly ArchetypeKind[] = BLUEPRINTS.map((b) => b.id);

/** Arrow keys walk the flat catalogue order, clamped at the ends (one column: ↑↓ step as ←→). */
export function moveHighlight(current: ArchetypeKind, delta: number): ArchetypeKind {
  const i = FLAT_ORDER.indexOf(current);
  if (i < 0) return FLAT_ORDER[0];
  return FLAT_ORDER[Math.min(Math.max(i + delta, 0), FLAT_ORDER.length - 1)];
}

// ── The schematic on each tile ─────────────────────────────────────────────────────────────

export interface Schematic {
  markers: { kind: BnetDocument["nodes"][number]["kind"]; x: number; y: number }[];
  edges: { from: [number, number]; to: [number, number]; isLoop: boolean; isBackward: boolean }[];
}

/** Every node and link of the built network, positions normalised into the unit square (`makeSchematic`). */
export function schematicOf(doc: BnetDocument): Schematic {
  if (!doc.nodes.length) return { markers: [], edges: [] };
  const xs = doc.nodes.map((n) => n.position[0]);
  const ys = doc.nodes.map((n) => n.position[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = maxX - minX;
  const sy = maxY - minY;
  const unit = (p: [number, number]): [number, number] => [sx > 0 ? (p[0] - minX) / sx : 0.5, sy > 0 ? (p[1] - minY) / sy : 0.5];
  const byId = new Map(doc.nodes.map((n) => [n.id, unit(n.position)]));
  const markers = doc.nodes.map((n) => {
    const [x, y] = byId.get(n.id)!;
    return { kind: n.kind, x, y };
  });
  const edges: Schematic["edges"] = [];
  for (const l of doc.links) {
    const from = byId.get(l.fromNodeID);
    const to = byId.get(l.toNodeID);
    if (!from || !to) continue;
    const isLoop = l.fromNodeID === l.toNodeID;
    edges.push({ from, to, isLoop, isBackward: !isLoop && to[0] <= from[0] });
  }
  return { markers, edges };
}

const schematics = new Map<ArchetypeKind, Promise<Schematic>>();

/** The tile's picture, built once per archetype at the catalogue defaults (cached, as 0.90.34 did). */
export function schematicFor(kind: ArchetypeKind): Promise<Schematic> {
  let p = schematics.get(kind);
  if (!p) {
    p = api.networkArchetype(galleryRequest(initialForm(true), kind)).then((b) => schematicOf(parseDocument(b.text)));
    p.catch(() => schematics.delete(kind));
    schematics.set(kind, p);
  }
  return p;
}

/** The summary line for the footer and the insert's status detail. */
export async function gallerySummary(f: GalleryForm): Promise<string> {
  return (await api.networkArchetype(galleryRequest(f))).summary;
}

// ── Insert ──────────────────────────────────────────────────────────────────────────────────

/**
 * Insert (or a double-click on a tile): the panel closes first, then the built network goes in as
 * one undo step "Insert <title>" with the summary as the status line's detail. Resolves to the
 * new nodes' ids, or null when nothing was inserted.
 */
export async function insertFromGallery(tabId: string, f: GalleryForm, kind: ArchetypeKind = f.highlighted): Promise<Set<string> | null> {
  const form = { ...f, highlighted: kind };
  if (galleryProblem(form)) return null;
  closeArchetypeGallery();
  if (!tabById(tabId)) return null;
  try {
    const { kind: _k, ...parameters } = galleryRequest(form);
    return await insertArchetype(editorFor(tabId), kind, parameters);
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    await report({ title: w.failedTitle, message });
    return null;
  }
}

/** For tests. */
export function resetGallery() {
  panel = null;
  schematics.clear();
  publish();
}
