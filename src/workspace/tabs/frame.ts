// The main window's frame across launches (0.90.34 ContentView.swift `WindowFrameAutosave`,
// `savedFrame(named:)`; ledger WS-141, WS-142). Saved under `WindowFrame.BNETMainWindow` in
// state.json in NSStringFromRect's form, "{{x, y}, {w, h}}", but in Tauri's logical points from the
// top-left of the desktop (0.90.34's AppKit origin was the bottom-left). A frame 200 pt or smaller
// either way is neither saved nor restored; a restored one is clamped onto the screen it overlaps
// most, or the main screen when it overlaps none.
import { getCurrentWindow, availableMonitors, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getStateValue, loadKv, setStateValues } from "../../lib/kv";

export const FRAME_KEY = "WindowFrame.BNETMainWindow";
/** 0.90.34 `WindowFrameAutosave.degenerateFrameSide`. */
export const DEGENERATE_SIDE = 200;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** NSStringFromRect's form. */
export function formatRect(r: Rect): string {
  return `{{${num(r.x)}, ${num(r.y)}}, {${num(r.w)}, ${num(r.h)}}}`;
}

/** NSRectFromString, for the form above; null for anything else. */
export function parseRect(s: unknown): Rect | null {
  if (typeof s !== "string") return null;
  const m = /^\{\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\s*,\s*\{\s*([\d.]+)\s*,\s*([\d.]+)\s*\}\}$/.exec(s.trim());
  if (!m) return null;
  const [x, y, w, h] = m.slice(1).map(Number);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
}

const usable = (r: Rect) => r.w > DEGENERATE_SIDE && r.h > DEGENERATE_SIDE;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 0.90.34 `savedFrame(named:)`'s clamp: onto ONE screen, the one it overlaps most, else `main`. */
export function clampFrame(rect: Rect, screens: Rect[], main: Rect | null): Rect {
  const visible = screens.filter((s) => s.w > 0 && s.h > 0);
  let best: Rect | null = null;
  let area = 0;
  for (const s of visible) {
    const a = overlap(s, rect);
    if (a > area) {
      area = a;
      best = s;
    }
  }
  const screen = best ?? main ?? visible[0] ?? null;
  if (!screen || screen.w <= 0 || screen.h <= 0) return rect;
  const w = Math.min(rect.w, screen.w);
  const h = Math.min(rect.h, screen.h);
  return {
    w,
    h,
    x: Math.max(screen.x, Math.min(rect.x, screen.x + screen.w - w)),
    y: Math.max(screen.y, Math.min(rect.y, screen.y + screen.h - h)),
  };
}

/** A monitor's visible frame (its work area) in logical points. */
function workArea(m: Monitor): Rect {
  const f = m.scaleFactor || 1;
  return { x: m.workArea.position.x / f, y: m.workArea.position.y / f, w: m.workArea.size.width / f, h: m.workArea.size.height / f };
}

/** The window's frame now, in logical points. */
async function currentFrame(): Promise<Rect | null> {
  try {
    const win = getCurrentWindow();
    const [f, p, s] = await Promise.all([win.scaleFactor(), win.outerPosition(), win.outerSize()]);
    const k = f || 1;
    return { x: p.x / k, y: p.y / k, w: s.width / k, h: s.height / k };
  } catch {
    return null;
  }
}

/** Saves the frame now, unless it is degenerate (teardown noise). */
export async function saveFrame(): Promise<void> {
  const r = await currentFrame();
  if (r && usable(r)) await setStateValues({ [FRAME_KEY]: formatRect(r) }).catch(() => {});
}

/** At launch: the saved frame, clamped onto a screen attached now. */
export async function restoreFrame(): Promise<void> {
  await loadKv().catch(() => {});
  const saved = parseRect(getStateValue<unknown>(FRAME_KEY, null));
  if (!saved || !usable(saved)) return;
  try {
    const [monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
    const r = clampFrame(saved, (monitors ?? []).map(workArea), primary ? workArea(primary) : null);
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(r.w, r.h));
    await win.setPosition(new LogicalPosition(r.x, r.y));
  } catch {
    // No window to move (the browser preview).
  }
}

/** Saves the frame after every move and resize (coalesced to one write per quarter second). */
export function trackFrame(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void saveFrame();
    }, 250);
  };
  const offs: (() => void)[] = [];
  let alive = true;
  try {
    const win = getCurrentWindow();
    for (const on of [win.onMoved.bind(win), win.onResized.bind(win)]) {
      on(later).then((u) => (alive ? offs.push(u) : u()), () => {});
    }
  } catch {
    // No window (the browser preview).
  }
  return () => {
    alive = false;
    if (timer !== null) clearTimeout(timer);
    offs.forEach((u) => u());
  };
}
