// Detached panes' window frames (`WindowFrame.DetachedPane.<pane>`, ledger WS-092), kept in
// state.json under 0.90.34's key in NSStringFromRect's spelling, by the same rules as the main
// window's (src/workspace/tabs/frame.ts, WS-141, INV-019): measured from the top-left of the
// desktop in points (AppKit measured from the bottom-left), so a 0.90.34 frame does not carry over;
// a frame 200 pt or smaller in either side is never saved or restored; a restored frame is clamped
// onto the one screen it overlaps most, or the main screen when it overlaps none.
import { auxWindow } from "../../lib/auxWindow";
import { inTauri } from "../../lib/api";
import { getStateValue, setStateValues } from "../../lib/kv";
import { clampFrame, DEGENERATE_SIDE, formatRect, parseRect, type Rect } from "../tabs/frame";

/** A frame in logical points from the top-left of the desktop. */
export type Frame = Rect;

export const detachedFrameKey = (rawPane: string) => `WindowFrame.DetachedPane.${rawPane}`;

export const isDegenerate = (f: Frame) => !(f.w > DEGENERATE_SIDE && f.h > DEGENERATE_SIDE);

/** NSWindow cascadeTopLeft(from:): the first window stays where it is, each next one steps down-right. */
export const CASCADE_STEP = 22;
export function cascadeFrom(prev: { x: number; y: number } | null, own: { x: number; y: number }): { x: number; y: number } {
  return prev ? { x: prev.x + CASCADE_STEP, y: prev.y + CASCADE_STEP } : own;
}

// --- The native side (Tauri). Every call is best-effort: a frame that can't be read or set
// leaves the window where macOS put it.

type TauriWindow = import("@tauri-apps/api/window").Window;

async function screens(): Promise<{ all: Frame[]; main: Frame | null }> {
  const w = await import("@tauri-apps/api/window");
  const toFrame = (m: import("@tauri-apps/api/window").Monitor): Frame => {
    const area = m.workArea ?? { position: m.position, size: m.size };
    return { x: area.position.x / m.scaleFactor, y: area.position.y / m.scaleFactor, w: area.size.width / m.scaleFactor, h: area.size.height / m.scaleFactor };
  };
  const [all, primary] = await Promise.all([w.availableMonitors(), w.primaryMonitor()]);
  return { all: all.map(toFrame), main: primary ? toFrame(primary) : null };
}

async function readFrame(win: TauriWindow): Promise<Frame> {
  const [pos, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
  return { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
}

async function applyFrame(win: TauriWindow, f: Frame, opts: { size: boolean }) {
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
  if (opts.size) await win.setSize(new LogicalSize(f.w, f.h));
  await win.setPosition(new LogicalPosition(f.x, f.y));
}

/** The remembered frame under `key`, clamped onto today's screens; null when none is usable. */
export async function restorableFrame(key: string): Promise<Frame | null> {
  const f = parseRect(getStateValue<unknown>(key, null));
  if (!f) return null;
  try {
    const s = await screens();
    return isDegenerate(f) ? null : clampFrame(f, s.all, s.main);
  } catch {
    return isDegenerate(f) ? null : f;
  }
}

/**
 * Keeps `win`'s frame saved under `key` on every move and resize (debounced), restoring it first
 * when one is remembered. `placeNew` positions a window that has no remembered frame (the detached
 * panes' cascade). Returns a function that stops.
 */
export function autosaveFrame(win: TauriWindow, key: string, placeNew?: (own: Frame) => Frame | null): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisten: (() => void)[] = [];
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const f = await readFrame(win);
        if (alive && !isDegenerate(f)) await setStateValues({ [key]: formatRect(f) });
      } catch {
        // The window went away.
      }
    }, 250);
  };
  void (async () => {
    try {
      const saved = await restorableFrame(key);
      if (saved) await applyFrame(win, saved, { size: true });
      else if (placeNew) {
        const next = placeNew(await readFrame(win));
        if (next) await applyFrame(win, next, { size: false });
      }
      if (!alive) return;
      unlisten.push(await win.onMoved(save), await win.onResized(save));
    } catch {
      // Not in the app, or no permission: the window stays where it opened.
    }
  })();
  return () => {
    alive = false;
    clearTimeout(timer);
    unlisten.forEach((u) => u());
  };
}

/** The Tauri window behind an auxiliary window (src-tauri windows.rs names it `aux-<name>`). */
export async function auxTauriWindow(name: string): Promise<TauriWindow | null> {
  if (!inTauri) return null;
  try {
    const { Window } = await import("@tauri-apps/api/window");
    for (let i = 0; i < 10; i++) {
      const w = await Window.getByLabel(auxWindow(name)?.label ?? `aux-${name}`);
      if (w) return w;
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch {
    // Not in the app.
  }
  return null;
}
