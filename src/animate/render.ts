// Drawing the animation (new in 2.1, ROADMAP Phase E): where each queue, server and count sits
// round its node, and each frame's picture of the tokens, on one 2D canvas laid over the drawing.
//
// Why a canvas and not SVG: a frame moves every travelling token, and a few hundred SVG elements
// restyled sixty times a second cost layout and paint for each, where a canvas costs one clear and
// a few hundred fills. Measured in render.test.ts (the per-frame work for 400 moving tokens) and
// in the preview (docs/help/animate.md gives the figures). The canvas is never part of an
// exported diagram: the export renders SceneLayers alone.
//
// Everything is placed from the scene (display space), so a pan, a zoom or a dragged node moves
// the animation with the drawing. A token remembers where it was last drawn in world
// coordinates, so it does not smear when the camera moves.
import type { CanvasScene, SceneLink } from "../canvas/geometry/scene";
import { outlineSize } from "../canvas/geometry/outline";
import { toDisplay, toLogical } from "../canvas/geometry/transform";
import type { Point } from "../canvas/geometry/types";
import type { AnimateLayout, AnimState, Token, Travel } from "./model";

/** Waiting customers drawn one by one; the rest are a "+12". Six keep a row clear of the next node at the usual spacing. */
export const QUEUE_VISIBLE = 6;
/** Servers drawn one by one; a station with more shows "busy/c". */
export const SERVERS_VISIBLE = 6;
/** How long a token takes to travel a link at 1×, in milliseconds of watching. */
export const TRAVEL_MS = 450;
export const MIN_TRAVEL_MS = 120;
/** Under Reduce Motion the picture is redrawn in steps this far apart. */
export const STEP_MS = 500;
/** Time constant of a waiting token closing up to its place in the row. */
const SETTLE_MS = 70;

/**
 * The shape that goes with a class's colour, so classes are told apart without colour. Eight, as
 * many as there are class colours, each a different outline at token size: the first eight
 * classes differ by shape alone (there were four, so Class 5 differed from Class 1 only by
 * colour; ledger FIX-108). `SHAPE_PATHS` is each one's outline for the bar's key.
 */
export const SHAPES = ["circle", "square", "triangle", "diamond", "plus", "wedge", "ring", "bar"] as const;
export type Shape = (typeof SHAPES)[number];
export const shapeOf = (cls: number): Shape => SHAPES[((cls % SHAPES.length) + SHAPES.length) % SHAPES.length];
/** The series token (1…8) of a class. */
export const seriesOf = (cls: number): number => (((cls % 8) + 8) % 8) + 1;

export interface StationGeometry {
  centre: Point;
  /** One per server drawn (at most SERVERS_VISIBLE). */
  serverSlots: Point[];
  /** Where "busy/c" is written when there are more servers than slots. */
  serverNote: Point;
  /** Head first. */
  queueSlots: Point[];
  /** Where "+12" is written, and where the customers it counts are taken to stand. */
  overflow: Point;
  /** +1: the queue grows to the left (its head is on the right), −1 the other way. */
  direction: 1 | -1;
  /** The live count's pill. */
  count: Point;
}

export interface Geometry {
  /** Token radius and the distance between neighbours, display points. */
  r: number;
  pitch: number;
  stations: (StationGeometry | null)[];
}

/** Where everything sits, in display space, for the scene as it is drawn now. */
export function geometry(scene: CanvasScene, layout: AnimateLayout): Geometry {
  const scale = scene.transform.scale;
  const k = Math.min(1.5, Math.max(0.55, scale));
  const r = 4.5 * k;
  const pitch = 2 * r + 3 * k;
  const stations = layout.stations.map((s): StationGeometry | null => {
    const c = scene.displayCentres.get(s.id);
    if (!c) return null;
    const half = (outlineSize("station").height * scale) / 2;
    const m = Math.min(s.servers, SERVERS_VISIBLE);
    const y = c.y - half - r - 5 * k;
    const serverSlots = Array.from({ length: m }, (_, i) => ({ x: c.x + (i - (m - 1) / 2) * pitch, y }));
    const b = scene.displayCentres.get(s.bufferId) ?? { x: c.x - 80 * scale, y: c.y };
    const bufferHalf = outlineSize("buffer");
    const direction: 1 | -1 = c.x >= b.x ? 1 : -1;
    const qy = b.y - (bufferHalf.height * scale) / 2 - r - 5 * k;
    const headX = b.x + direction * ((bufferHalf.width * scale) / 2 - r);
    const queueSlots = Array.from({ length: QUEUE_VISIBLE }, (_, i) => ({ x: headX - direction * i * pitch, y: qy }));
    return {
      centre: c,
      serverSlots,
      serverNote: { x: c.x + ((m - 1) / 2) * pitch + r + 4 * k, y },
      queueSlots,
      overflow: { x: headX - direction * QUEUE_VISIBLE * pitch, y: qy },
      direction,
      count: { x: c.x + half + 4 * k, y: c.y + half * 0.55 },
    };
  });
  return { r, pitch, stations };
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────

const linkIndex = new WeakMap<CanvasScene, Map<string, SceneLink>>();

/** The drawn link from one node to another, for the class if there is one, else any. */
export function linkFor(scene: CanvasScene, from: string, to: string, cls: number): SceneLink | undefined {
  let index = linkIndex.get(scene);
  if (!index) {
    index = new Map();
    for (const l of scene.links) {
      index.set(`${l.link.fromNodeID}|${l.link.toNodeID}|${l.link.customerClass}`, l);
      const any = `${l.link.fromNodeID}|${l.link.toNodeID}|`;
      if (!index.has(any)) index.set(any, l);
    }
    linkIndex.set(scene, index);
  }
  return index.get(`${from}|${to}|${cls}`) ?? index.get(`${from}|${to}|`);
}

/** The point a fraction `f` (0…1) of the way along a polyline. */
export function along(points: readonly Point[], f: number): Point {
  if (points.length === 1 || f <= 0) return points[0];
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (f >= 1 || total === 0) return points[points.length - 1];
  let want = f * total;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (want <= seg && seg > 0) {
      const u = want / seg;
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * u, y: points[i - 1].y + (points[i].y - points[i - 1].y) * u };
    }
    want -= seg;
  }
  return points[points.length - 1];
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

interface Mover {
  token: Token;
  travel: Travel;
  startedAt: number;
  duration: number;
  /** Where it set off from (world), when it had been drawn before. */
  start: Point | null;
}

export interface Palette {
  /** Index 1…8. */
  series: string[];
  text: string;
  muted: string;
  panel: string;
  line: string;
}

/** The palette from the tokens in force on `el` (light, dark, more contrast). */
export function readPalette(el: Element): Palette {
  const view = el.ownerDocument.defaultView;
  const style = view ? view.getComputedStyle(el) : null;
  const token = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  return {
    series: ["", ...Array.from({ length: 8 }, (_, i) => token(`--series-${i + 1}`, "CanvasText"))],
    text: token("--canvas-text", "CanvasText"),
    muted: token("--muted", "GrayText"),
    panel: token("--canvas-panel", "Canvas"),
    line: token("--canvas-separator", "GrayText"),
  };
}

/** The subset of CanvasRenderingContext2D the picture uses (tests pass a recorder). */
export type Pen = Pick<
  CanvasRenderingContext2D,
  "beginPath" | "arc" | "rect" | "moveTo" | "lineTo" | "closePath" | "fill" | "stroke" | "fillText" | "measureText" | "clearRect" | "setTransform" | "roundRect"
> & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textAlign: string; textBaseline: string; globalAlpha: number };

export function shapePath(pen: Pen, shape: Shape, x: number, y: number, r: number) {
  pen.beginPath();
  switch (shape) {
    case "circle":
      pen.arc(x, y, r, 0, Math.PI * 2);
      break;
    case "square":
      pen.rect(x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72);
      break;
    case "triangle":
      pen.moveTo(x, y - r * 1.1);
      pen.lineTo(x + r * 1.05, y + r * 0.8);
      pen.lineTo(x - r * 1.05, y + r * 0.8);
      pen.closePath();
      break;
    case "diamond":
      pen.moveTo(x, y - r * 1.15);
      pen.lineTo(x + r * 1.15, y);
      pen.lineTo(x, y + r * 1.15);
      pen.lineTo(x - r * 1.15, y);
      pen.closePath();
      break;
    case "plus": {
      // A cross with arms a third of its width.
      const [a, b] = [r * 1.1, r * 0.4];
      const outline: [number, number][] = [[-b, -a], [b, -a], [b, -b], [a, -b], [a, b], [b, b], [b, a], [-b, a], [-b, b], [-a, b], [-a, -b], [-b, -b]];
      outline.forEach(([dx, dy], i) => (i ? pen.lineTo(x + dx, y + dy) : pen.moveTo(x + dx, y + dy)));
      pen.closePath();
      break;
    }
    case "wedge":
      // A triangle pointing down.
      pen.moveTo(x, y + r * 1.1);
      pen.lineTo(x + r * 1.05, y - r * 0.8);
      pen.lineTo(x - r * 1.05, y - r * 0.8);
      pen.closePath();
      break;
    case "ring":
      // A circle with a hole: the inner arc runs the other way, so the fill leaves it open.
      pen.arc(x, y, r * 1.05, 0, Math.PI * 2);
      pen.moveTo(x + r * 0.45, y);
      pen.arc(x, y, r * 0.45, 0, Math.PI * 2, true);
      break;
    case "bar":
      // A flat rectangle, twice as wide as it is tall.
      pen.rect(x - r * 1.2, y - r * 0.6, r * 2.4, r * 1.2);
      break;
  }
}

/** Each shape's outline in a 12 × 12 box centred on 0, for the key beside the class names (fill-rule evenodd). */
export const SHAPE_PATHS: Record<Shape, string> = {
  circle: "M4.5 0 A4.5 4.5 0 1 0 -4.5 0 A4.5 4.5 0 1 0 4.5 0 Z",
  square: "M-4 -4 H4 V4 H-4 Z",
  triangle: "M0 -5 L4.8 3.8 L-4.8 3.8 Z",
  diamond: "M0 -5.2 L5.2 0 L0 5.2 L-5.2 0 Z",
  plus: "M-1.8 -5 H1.8 V-1.8 H5 V1.8 H1.8 V5 H-1.8 V1.8 H-5 V-1.8 H-1.8 Z",
  wedge: "M0 5 L4.8 -3.8 L-4.8 -3.8 Z",
  ring: "M4.8 0 A4.8 4.8 0 1 0 -4.8 0 A4.8 4.8 0 1 0 4.8 0 Z M2.1 0 A2.1 2.1 0 1 1 -2.1 0 A2.1 2.1 0 1 1 2.1 0 Z",
  bar: "M-5.4 -2.7 H5.4 V2.7 H-5.4 Z",
};

export interface FrameCounts {
  /** Tokens drawn at rest (in a server or a queue place), and on the move. */
  resting: number;
  moving: number;
}

/**
 * The moving picture: which tokens are on their way, and one frame's drawing. One per animation
 * layer; `reduced` (Reduce Motion) draws no travelling tokens — customers simply stand where
 * they are.
 */
export class Stage {
  movers: Mover[] = [];
  reduced = false;
  private lastDraw: number | null = null;

  /** Takes up the moves the bookkeeping has noted since the last frame. */
  pickUp(state: AnimState, nowMs: number, speed: number) {
    const moved = state.moved;
    if (!moved.length) return;
    const duration = Math.max(MIN_TRAVEL_MS, TRAVEL_MS / Math.sqrt(Math.max(1, speed)));
    for (const token of moved) {
      const travel = token.travel;
      token.travel = null;
      if (!travel) continue;
      if (this.reduced) continue;
      const existing = this.movers.find((m) => m.token === token);
      if (existing) {
        // Still on its way: a start of service only changes where it is going; a new link is a new leg.
        if (travel.kind === "serve") continue;
        existing.travel = travel;
        existing.start = token.drawn ? { x: token.x, y: token.y } : null;
        existing.startedAt = nowMs;
        existing.duration = duration;
        continue;
      }
      this.movers.push({ token, travel, startedAt: nowMs, duration: travel.kind === "serve" ? duration * 0.6 : duration, start: token.drawn ? { x: token.x, y: token.y } : null });
    }
    moved.length = 0;
    if (this.reduced) state.leaving.length = 0;
  }

  /** Where a token stands when at rest, or null when it is not drawn one by one. */
  private place(token: Token, state: AnimState, g: Geometry, scene: CanvasScene, travel: Travel | null): Point | null {
    if (token.station < 0) return travel?.to ? (scene.displayCentres.get(travel.to) ?? null) : null;
    const sg = g.stations[token.station];
    if (!sg) return null;
    if (token.server >= 0) return sg.serverSlots[token.server] ?? sg.serverNote;
    const i = state.stations[token.station].queue.indexOf(token, QUEUE_VISIBLE);
    return i >= 0 ? sg.queueSlots[i] : sg.overflow;
  }

  /** Draws one frame. `pen` is already scaled to display points. */
  draw(pen: Pen, state: AnimState, scene: CanvasScene, palette: Palette, nowMs: number, size: { width: number; height: number }): FrameCounts {
    const g = geometry(scene, state.layout);
    const t = scene.transform;
    const dt = this.lastDraw === null ? 0 : Math.max(0, nowMs - this.lastDraw);
    this.lastDraw = nowMs;
    const settle = this.reduced ? 1 : 1 - Math.exp(-dt / SETTLE_MS);
    pen.clearRect(0, 0, size.width, size.height);
    pen.lineWidth = 1;
    const fontPx = Math.max(9, Math.round(10 * Math.min(1.3, Math.max(0.8, t.scale))));
    pen.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, sans-serif`;
    pen.textBaseline = "middle";

    const flying = new Set<Token>();
    for (const m of this.movers) flying.add(m.token);

    const token = (tk: Token, p: Point) => {
      shapePath(pen, shapeOf(tk.cls), p.x, p.y, g.r);
      pen.fillStyle = palette.series[seriesOf(tk.cls)];
      pen.fill();
      pen.strokeStyle = palette.panel;
      pen.stroke();
    };
    /** A token at rest closes up to its place; returns where it is drawn. */
    const rest = (tk: Token, target: Point): Point => {
      const w = toLogical(t, target);
      if (!tk.drawn || settle >= 1) {
        tk.x = w.x;
        tk.y = w.y;
        tk.drawn = true;
        return target;
      }
      tk.x += (w.x - tk.x) * settle;
      tk.y += (w.y - tk.y) * settle;
      return toDisplay(t, { x: tk.x, y: tk.y });
    };

    let resting = 0;
    state.stations.forEach((st, i) => {
      const sg = g.stations[i];
      if (!sg) return;
      // Servers: an empty ring when idle, the customer's token when busy.
      sg.serverSlots.forEach((p, k) => {
        const tk = st.servers[k];
        pen.beginPath();
        pen.arc(p.x, p.y, g.r + 1.5, 0, Math.PI * 2);
        pen.fillStyle = palette.panel;
        pen.fill();
        pen.strokeStyle = tk ? palette.text : palette.line;
        pen.stroke();
        if (tk && !flying.has(tk)) {
          token(tk, rest(tk, p));
          resting++;
        }
      });
      if (st.servers.length > sg.serverSlots.length) {
        pen.fillStyle = palette.text;
        pen.textAlign = "left";
        pen.fillText(`${st.busy}/${st.servers.length}`, sg.serverNote.x, sg.serverNote.y);
      }
      // The queue: the first few one by one, the rest as a number.
      const shown = Math.min(st.queue.length, QUEUE_VISIBLE);
      let places = 0;
      for (let k = 0; k < shown; k++) {
        // After a skip a very long queue is named only at its head; the rest is in the count.
        const tk = st.queue.at(k);
        if (!tk) continue;
        places++;
        if (flying.has(tk)) continue;
        token(tk, rest(tk, sg.queueSlots[k]));
        resting++;
      }
      if (st.queue.length > places) {
        pen.fillStyle = palette.text;
        pen.textAlign = sg.direction === 1 ? "right" : "left";
        pen.fillText(`+${st.queue.length - places}`, sg.overflow.x + sg.direction * g.r, sg.overflow.y);
      }
      // The live count, in a pill.
      const label = String(st.queue.length + st.busy);
      const w = Math.max(fontPx + 6, pen.measureText(label).width + 10);
      const h = fontPx + 6;
      pen.beginPath();
      pen.roundRect(sg.count.x, sg.count.y - h / 2, w, h, h / 2);
      pen.fillStyle = palette.panel;
      pen.fill();
      pen.strokeStyle = palette.line;
      pen.stroke();
      pen.fillStyle = palette.text;
      pen.textAlign = "center";
      pen.fillText(label, sg.count.x + w / 2, sg.count.y + 0.5);
    });

    // Tokens on their way, on top.
    let moving = 0;
    const kept: Mover[] = [];
    for (const m of this.movers) {
      const f = (nowMs - m.startedAt) / m.duration;
      const dest = this.place(m.token, state, g, scene, m.travel);
      if (f >= 1 || !dest) {
        if (m.token.station < 0) {
          const at = state.leaving.indexOf(m.token);
          if (at >= 0) state.leaving.splice(at, 1);
        } else m.token.drawn = false; // lands exactly on its place next frame
        if (dest && m.token.station >= 0) {
          const w = toLogical(t, dest);
          m.token.x = w.x;
          m.token.y = w.y;
          m.token.drawn = true;
          // Drawn where it lands, unless it is one of the customers a "+12" stands for.
          if (dest !== g.stations[m.token.station]?.overflow && dest !== g.stations[m.token.station]?.serverNote) {
            token(m.token, dest);
            resting++;
          }
        }
        continue;
      }
      const path: Point[] = [];
      if (m.start) path.push(toDisplay(t, m.start));
      if (m.travel.from && m.travel.to) {
        const link = linkFor(scene, m.travel.from, m.travel.to, m.travel.viaClass);
        if (link) for (const p of link.geometry.polyline) path.push(p);
        else if (!m.start) {
          const c = scene.displayCentres.get(m.travel.from);
          if (c) path.push(c);
        }
      }
      path.push(dest);
      const p = along(path, ease(f));
      const w = toLogical(t, p);
      m.token.x = w.x;
      m.token.y = w.y;
      m.token.drawn = true;
      token(m.token, p);
      moving++;
      kept.push(m);
    }
    this.movers = kept;
    return { resting, moving };
  }

  /** True while something is still travelling (the frame loop keeps going for it). */
  get busy(): boolean {
    return this.movers.length > 0;
  }

  reset() {
    this.movers = [];
    this.lastDraw = null;
  }
}
