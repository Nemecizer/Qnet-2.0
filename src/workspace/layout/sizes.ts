// The pane layout's arithmetic, as pure functions (jsdom has no layout, so this is what the tests
// check): 0.90.34's DS.Layout sizes, the four split views and their flexible panes, divider drags,
// the coupled right-column / AI widths, the preset row heights, the window's minimum size and the
// split-size keys with their one-time migrations (ledger WS-002, WS-057…059, WS-063…068, WS-079).

/** DesignSystem.swift `DS.Layout`, in points (CSS pixels). */
export const L = {
  paletteMin: 152,
  paletteIdeal: 176,
  paletteMax: 240,
  canvasMinWidth: 496,
  rightMin: 288,
  rightIdeal: 320,
  inspectorMinHeight: 200,
  inspectorIdealHeight: 360,
  statusMinHeight: 200,
  canvasRowMin: 320,
  canvasRowIdeal: 520,
  rowMin: 192,
  rowIdeal: 248,
  shellRowIdeal: 424,
  shellMinWidth: 496,
  aiMinWidth: 224,
  aiDefaultWidth: 255,
  mainMinWidth: 1000,
  detachedDefault: [880, 560] as [number, number],
  detachedMin: [480, 280] as [number, number],
  /** The divider's own thickness (NSSplitView's thin divider). */
  divider: 1,
};

/** ContentView.swift's four split views (WS-063): name, full pane set, the pane that takes the slack. */
export type SplitName = "OuterVSplit" | "TopHSplit" | "RightVSplit" | "BottomHSplit";

export interface SplitDef {
  name: SplitName;
  vertical: boolean;
  canonical: string[];
  flexible: string;
}

export const SPLITS: Record<SplitName, SplitDef> = {
  OuterVSplit: { name: "OuterVSplit", vertical: true, canonical: ["top", "results", "bottom"], flexible: "top" },
  TopHSplit: { name: "TopHSplit", vertical: false, canonical: ["palette", "canvas", "right"], flexible: "canvas" },
  RightVSplit: { name: "RightVSplit", vertical: true, canonical: ["inspector", "status"], flexible: "status" },
  BottomHSplit: { name: "BottomHSplit", vertical: false, canonical: ["terminal", "ai"], flexible: "terminal" },
};

export const paneKey = (split: SplitName, pane: string) => `SplitPane.${split}.${pane}`;
export const legacyKey = (split: SplitName) => `SplitSizes.${split}`;

export interface Extent {
  min: number;
  ideal?: number;
  max?: number;
}

/** Which panes the window shows now (ContentView `shows(_:)` for each), for the size rules. */
export interface Shown {
  palette: boolean;
  canvas: boolean;
  status: boolean;
  inspector: boolean;
  results: boolean;
  shell: boolean;
  ai: boolean;
}

/**
 * Min / ideal / max of one pane of one split (ContentView's `.frame` modifiers). The bottom row's
 * ideal is the Shell row's 424 pt when the Shell is shown without the AI pane and without
 * Results (WS-058); the AI pane's ideal is its last saved width (WS-059).
 */
export function extentOf(split: SplitName, pane: string, shown: Shown, aiWidth: number): Extent {
  switch (`${split}.${pane}`) {
    case "OuterVSplit.top": return { min: L.canvasRowMin, ideal: L.canvasRowIdeal };
    case "OuterVSplit.results": return { min: L.rowMin, ideal: L.rowIdeal };
    case "OuterVSplit.bottom": return { min: L.rowMin, ideal: shown.shell && !shown.ai && !shown.results ? L.shellRowIdeal : L.rowIdeal };
    case "TopHSplit.palette": return { min: L.paletteMin, ideal: L.paletteIdeal, max: L.paletteMax };
    case "TopHSplit.canvas": return { min: L.canvasMinWidth };
    case "TopHSplit.right": return { min: L.rightMin, ideal: L.rightIdeal };
    case "RightVSplit.inspector": return { min: L.inspectorMinHeight, ideal: L.inspectorIdealHeight };
    case "RightVSplit.status": return { min: L.statusMinHeight };
    case "BottomHSplit.terminal": return { min: L.shellMinWidth };
    case "BottomHSplit.ai": return { min: L.aiMinWidth, ideal: aiWidth };
    default: return { min: 0 };
  }
}

/** AppSettings.swift `aiPaneWidth`: the saved AI width, then the legacy array's last entry, else 255. */
export function aiPaneWidth(state: Record<string, unknown>): number {
  const w = state[paneKey("BottomHSplit", "ai")];
  if (typeof w === "number" && w > 10) return w;
  const legacy = state[legacyKey("BottomHSplit")];
  if (Array.isArray(legacy) && legacy.length >= 2) {
    const last = legacy[legacy.length - 1];
    if (typeof last === "number" && last > 10) return last;
  }
  return L.aiDefaultWidth;
}

/** A saved pane size, if usable (> 1 pt, as `restore()` requires). */
export function savedSize(state: Record<string, unknown>, split: SplitName, pane: string): number | undefined {
  const v = state[paneKey(split, pane)];
  return typeof v === "number" && v > 1 ? v : undefined;
}

/**
 * The size a non-flexible pane is laid out at: its saved size, else its ideal, else its minimum,
 * kept inside its own range. The flexible pane takes what is left (CSS flex does the rest, and
 * shrinks fixed panes toward their minimums when the window is too small for them).
 */
export function basisOf(split: SplitName, pane: string, ext: Extent, state: Record<string, unknown>): number {
  const s = savedSize(state, split, pane) ?? ext.ideal ?? ext.min;
  return clamp(s, ext.min, ext.max ?? Infinity);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Drags the divider between panes `i` and `i + 1` by `delta` (NSSplitView: only the two neighbours
 * change, each kept inside its own range). `sizes` are the panes' measured sizes when the drag
 * began. Returns the new sizes.
 */
export function dragDivider(sizes: number[], extents: Extent[], i: number, delta: number): number[] {
  const a = sizes[i];
  const b = sizes[i + 1];
  const ea = extents[i];
  const eb = extents[i + 1];
  // How far it may go: a between its min and max, b likewise.
  const lo = Math.max(ea.min - a, b - (eb.max ?? Infinity));
  const hi = Math.min((ea.max ?? Infinity) - a, b - eb.min);
  const d = lo > hi ? 0 : clamp(delta, lo, hi);
  const out = sizes.slice();
  out[i] = a + d;
  out[i + 1] = b - d;
  return out;
}

/**
 * What a split saves after a drag (WS-064): every non-flexible pane's size, and the legacy array
 * when the full pane set is shown. Nothing while fewer than two panes are present or while any
 * size is ≤ 1 pt.
 */
export function savePatch(def: SplitDef, panes: string[], sizes: number[]): Record<string, number | number[]> | null {
  if (panes.length < 2 || sizes.length !== panes.length || sizes.some((s) => s <= 1)) return null;
  const patch: Record<string, number | number[]> = {};
  panes.forEach((p, i) => {
    if (p !== def.flexible) patch[paneKey(def.name, p)] = round(sizes[i]);
  });
  if (sameList(panes, def.canonical)) patch[legacyKey(def.name)] = sizes.map(round);
  return patch;
}

const round = (v: number) => Math.round(v * 100) / 100;

export function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The coupled width (WS-067): after the top row or the bottom row changes the width of its
 * right-most pane, the other row's right-most pane takes the same width, but only while both rows
 * show their full pane sets, and only when the widths differ by more than half a point. Returns
 * the state patch for the other row, or null.
 */
export function mirrorPatch(
  source: "TopHSplit" | "BottomHSplit",
  rightWidth: number,
  topPanes: string[],
  bottomPanes: string[],
  otherRightWidth: number,
  otherRowWidth: number,
): Record<string, number> | null {
  if (!sameList(topPanes, SPLITS.TopHSplit.canonical) || !sameList(bottomPanes, SPLITS.BottomHSplit.canonical)) return null;
  if (rightWidth <= 1 || otherRowWidth <= 1 || Math.abs(rightWidth - otherRightWidth) <= 0.5) return null;
  const other = source === "TopHSplit" ? paneKey("BottomHSplit", "ai") : paneKey("TopHSplit", "right");
  return { [other]: round(rightWidth) };
}

/**
 * WorkspaceLayout.setOuterRowHeight (WS-079): a preset's row height as a share of the WINDOW's
 * height, clamped between the row minimum (192) and what leaves the canvas row its 320; null (write
 * nothing) when both minimums do not fit.
 */
export function presetRowHeight(windowHeight: number, workspaceHeight: number, fraction: number): number | null {
  const smallest = L.rowMin;
  const largest = workspaceHeight - L.canvasRowMin - L.divider;
  if (!(largest >= smallest)) return null;
  return Math.round(clamp(windowHeight * fraction, smallest, largest) * 100) / 100;
}

/** ContentView `contentMinHeight` (WS-002): 320 for the canvas row, 192 for each other row shown. */
export function contentMinHeight(outerPanes: string[]): number {
  return outerPanes.reduce((t, row) => t + (row === "top" ? L.canvasRowMin : L.rowMin), 0);
}

/**
 * One-time repairs of 0.90.x split state (WS-068), and the legacy arrays seeding missing per-pane
 * keys (WS-066): `SplitPane.TopHSplit.status` seeds `…right`; the `migration.bottomHSplit.2026-04-24`
 * flag clears a corrupt `SplitSizes.BottomHSplit` once. Returns the patch to write (empty: nothing).
 */
export function migrationPatch(state: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const view = { ...state };
  const flag = "migration.bottomHSplit.2026-04-24";
  if (view[flag] !== true) {
    if (legacyKey("BottomHSplit") in view) patch[legacyKey("BottomHSplit")] = null;
    delete view[legacyKey("BottomHSplit")];
    patch[flag] = true;
  }
  const oldRight = "SplitPane.TopHSplit.status";
  if (view[paneKey("TopHSplit", "right")] === undefined && typeof view[oldRight] === "number") {
    patch[paneKey("TopHSplit", "right")] = view[oldRight];
    view[paneKey("TopHSplit", "right")] = view[oldRight];
  }
  for (const def of Object.values(SPLITS)) {
    const legacy = view[legacyKey(def.name)];
    if (!Array.isArray(legacy) || legacy.length !== def.canonical.length) continue;
    def.canonical.forEach((p, i) => {
      const k = paneKey(def.name, p);
      if (p !== def.flexible && view[k] === undefined && typeof legacy[i] === "number") patch[k] = legacy[i];
    });
  }
  return patch;
}

// --- Corner grips (CornerResizeOverlay.swift, WS-069/070)

export type Quadrant = "upperLeft" | "upperRight" | "lowerLeft" | "lowerRight";

export const CORNER_HIT = 24;

/** The quadrant of the 24 × 24 grip under the pointer, from its offset to the grip's centre. */
export function quadrantOf(dx: number, dy: number): Quadrant {
  const left = dx < 0;
  const above = dy < 0;
  if (above) return left ? "upperLeft" : "upperRight";
  return left ? "lowerLeft" : "lowerRight";
}

/** The L glyph of a quadrant as an SVG path inside the 24 × 24 grip (UL ┘, UR └, LL ┐, LR ┌). */
export function lPath(q: Quadrant): string {
  const arm = CORNER_HIT / 2;
  // The arm square's origin in the grip.
  const ox = q === "upperLeft" || q === "lowerLeft" ? 0 : arm;
  const oy = q === "upperLeft" || q === "upperRight" ? 0 : arm;
  const [minX, maxX, minY, maxY] = [ox, ox + arm, oy, oy + arm];
  let cx: number, cy: number, ex: number, ey: number;
  switch (q) {
    case "upperLeft": [cx, cy, ex, ey] = [maxX, maxY, minX, minY]; break;
    case "upperRight": [cx, cy, ex, ey] = [minX, maxY, maxX, minY]; break;
    case "lowerLeft": [cx, cy, ex, ey] = [maxX, minY, minX, maxY]; break;
    default: [cx, cy, ex, ey] = [minX, minY, maxX, maxY];
  }
  return `M${cx} ${ey} L${cx} ${cy} L${ex} ${cy}`;
}
