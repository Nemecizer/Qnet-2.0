// The canvas's words (0.90.34 NetworkCanvasLayers.swift, NetworkCanvasOverlays.swift, the
// `CanvasStatusBar` in ContentView.swift, NetworkCanvasView.swift's accessibility elements and
// DesignSystem.swift's `DS.Glossary`), kept exactly where the ledger quotes them. Re-exported by
// src/lib/vocabulary.ts. The drawing area wrote the first half; the interaction area appends its
// words below the marked line.
import { interactionWords } from "./interaction/words";

/** "Class 3" (1-based), `CustomerClass.label(for:)`. */
const cls = (i: number) => `Class ${i + 1}`;

export const canvasWords = {
  className: cls,

  // ── Glossary (DS.Glossary), the tooltip lines for the symbols drawn under a node ──────────
  glossary: {
    lambda: "λ — arrival rate: mean number of jobs entering per unit time (1 / mean interarrival time).",
    mu: "μ — service rate: mean number of jobs a single server completes per unit time (1 / mean service time).",
    scv: "SCV (c²) — squared coefficient of variation: variance divided by the square of the mean. 1 for exponential, 0 for deterministic, above 1 for bursty.",
  },

  // ── Nodes (NetworkNodeView) ────────────────────────────────────────────────────────────────
  bufferDetail: (size: number) => `b=${size}`,
  servers: (c: number) => ` c=${c}`,
  multiClass: "Multi-class",
  serviceRate: (rate: string) => `service rate μ = ${rate} jobs per time unit per server`,
  arrivalRate: (rate: string) => `arrival rate λ = ${rate} jobs per time unit`,
  scvSpoken: (scv: string, kind: string) => `SCV ${scv}${kind}`,
  scvKind: { exponential: " (exponential)", deterministic: " (deterministic)", bursty: " (burstier than exponential)", steady: " (steadier than exponential)" },
  utilisationSpoken: (rho: string) => `utilisation ρ ${rho}`,

  // ── ρ badge (utilisationBadge) ─────────────────────────────────────────────────────────────
  rhoBadge: (rho: string) => `ρ ${rho}`,
  rhoHelp: (rho3: string, load: string) => `Utilisation ρ = ${rho3} from the traffic equations (α / c·μ); updates as you edit. ${load}`,
  rhoLoad: { unstable: "Unstable: ρ ≥ 1.", heavy: "Heavy traffic.", moderate: "Moderate load.", light: "Light load." },

  // ── Accessibility containers ──────────────────────────────────────────────────────────────
  canvasLabel: "Network canvas",
  nodesLabel: "Nodes",
  linksLabel: "Links",

  // ── Class legend (CanvasClassLegend) ──────────────────────────────────────────────────────
  legendLabel: "Customer class legend",
  legendChipLabel: (i: number) => `${cls(i)} filter`,
  legendHelpActive: (i: number) => `Showing only ${cls(i)} routing. Click to clear the filter.`,
  legendHelp: (i: number) => `Click to show only ${cls(i)} routing.`,
  on: "on",
  off: "off",

  // ── Zoom cluster (CanvasZoomCluster) ──────────────────────────────────────────────────────
  zoomControls: "Zoom controls",
  zoomOut: "Zoom Out",
  zoomIn: "Zoom In",
  zoomOutHelp: "Zoom out (⌘−)",
  zoomInHelp: "Zoom in (⌘=)",
  zoomLevel: "Zoom level",
  zoomLevelHelp: (fit: string, selection: string, actual: string) =>
    `Zoom level — pick a preset, Zoom to Fit (${fit}) or Zoom to Selection (${selection}). ${actual} is actual size.`,
  percent: (scale: number) => `${Math.round(scale * 100)}%`,
  zoomToFit: "Zoom to Fit",
  zoomToSelection: "Zoom to Selection",
  zoomToFitHelp: (fit: string) => `Zoom to fit the whole network (${fit})`,
  snapToGrid: "Snap to Grid",
  snapHelpSuspended: "Free placement — ⌃ is held, so Snap to Grid and the alignment guides stand down for this drag",
  snapHelpOn: "Snap to Grid is on — node moves land on the 28 pt grid (⌥⌘G to turn off). Hold ⌃ while dragging to place a node freely.",
  snapHelpOff: "Snap to Grid is off (⌥⌘G to turn on). Alignment guides still line a dragged node up with its neighbours; hold ⌃ to place it freely.",

  // ── Empty canvas (CanvasEmptyHint) ────────────────────────────────────────────────────────
  emptyTitle: "No Network Yet",
  emptyMessage: "Press S, then click to place a station. A station is served through exactly one buffer: Source → Buffer → Station → Sink.",
  emptyArchetype: "Start from an Archetype…",
  emptyArchetypeHelp: "Insert a ready-made network — tandem line, M/M/c station, fork, rework loop or re-entrant pair — at a chosen size and utilisation",
  emptyExample: "Open an Example…",
  emptyExampleHelp: "Open one of the 50 bundled literature networks",

  // ── Status bar (ContentView.swift CanvasStatusBar) ────────────────────────────────────────
  statusBar: "Status bar",
  toolHelp: "Active tool. Switch in the Tools pane or with its letter shortcut. Hold Space, or drag with the middle mouse button, to pan in any tool.",
  zoomHelp: (zin: string, zout: string, actual: string, fit: string, sel: string) =>
    `Canvas zoom (${zin} / ${zout}; ${actual} actual size, ${fit} zoom to fit, ${sel} zoom to selection; ⌥-scroll or pinch to zoom about the pointer)`,
  selecting: (n: number) => `Selecting ${n} node${n === 1 ? "" : "s"}`,
  selectingHelp: "Nodes inside the selection rectangle",
  selectionHelp: "What is selected on the canvas — nodes, a link, or both (⌘A selects all nodes, Escape or ⌥⌘A deselects everything)",
  selectionSummary: (nodes: number, link: boolean) =>
    nodes === 0
      ? link
        ? "Selected 1 link"
        : "No selection"
      : `Selected ${nodes} node${nodes === 1 ? "" : "s"}${link ? ", 1 link" : ""}`,
  primitivesHelp: "Network primitives: sources, stations, buffers, sinks, links",
  primitives: [
    ["source", "source", "sources"],
    ["station", "station", "stations"],
    ["buffer", "buffer", "buffers"],
    ["sink", "sink", "sinks"],
    ["link", "link", "links"],
  ] as const,
  countSpoken: (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`,
  snapHelpBarSuspended: "Free placement: ⌃ is held, so Snap to Grid and the alignment guides stand down for this drag",
  snapHelpBar: (key: string) => `Snap to Grid (${key}). Hold ⌃ while dragging to place a node freely.`,
  snapSpoken: { suspended: "Snap to grid suspended", on: "Snap to grid on", off: "Snap to grid off" },
  freePlacement: "Free placement",
  infiniteBuffers: "Infinite buffers",
  finiteBuffers: "Finite buffers",
  infiniteBuffersHelp: "Infinite buffers: unbounded queues (BNA / QNA / spectral orthant methods)",
  finiteBuffersHelp: "Finite buffers: bounded queues with blocking (fBNA methods)",
  pan: (x: number, y: number) => `Pan ${x}, ${y} pt`,
  panHelp: (actual: string) => `Canvas pan offset in points (${actual} returns to actual size at the origin)`,
  panSpoken: (x: number, y: number) => `Canvas panned by ${x} and ${y} points`,

  // ── Interaction area's words below this line ──────────────────────────────────────────────
  /** The Tools pane and menu, the context menus, the View tooltips, Find Node: src/canvas/interaction/words.ts. */
  interaction: interactionWords,
} as const;
