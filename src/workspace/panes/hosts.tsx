// Where each pane's React tree lives (ledger WS-056, WS-089, WS-095, INV-018): every pane renders
// once, through a portal, into a host element of its own that never changes. The layout only moves
// that host element between slots: a docked slot in the split tree, or the body of the pane's own
// window when it is detached. So rearranging, maximizing, detaching and reattaching never remount a
// pane (React keeps the portal; the DOM node moves), and a pane is in one place at a time by
// construction. The canvas and, once shown, the Shell stay mounted while hidden too, so the canvas
// keeps its view and P6's terminal its process and scrollback.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AuxWindow } from "../../lib/auxWindow";
import { inTauri } from "../../lib/api";
import { useActiveTab } from "../store";
import type { PaneId } from "../focus";
import { L } from "../layout/sizes";
import { auxTauriWindow, autosaveFrame, cascadeFrom, detachedFrameKey, type Frame } from "../layout/frames";
import { trackFocusIn } from "./focusState";
import { RAW, setDetached } from "./model";
import { PANE_NAME, paneWords } from "./words";

const hosts = new Map<PaneId, HTMLElement>();

/** The element a pane's tree is rendered into (created on first use, never replaced). */
export function paneHost(p: PaneId): HTMLElement {
  let el = hosts.get(p);
  if (!el) {
    el = document.createElement("div");
    el.className = "pane-host";
    el.dataset.paneHost = p;
    hosts.set(p, el);
  }
  return el;
}

/** The pane's host if its tree is mounted and placed in a window now. */
export function placedHost(p: PaneId): HTMLElement | null {
  const el = hosts.get(p);
  return el && el.isConnected ? el : null;
}

/** Fades are skipped until the first layout has been drawn (no fade at launch). */
let settled = false;
export function markLayoutSettled() {
  settled = true;
}

/** Where a pane appears: moves the pane's host element in while mounted. */
export function PaneSlot({ pane, fade = true }: { pane: PaneId; fade?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fadeIn = useRef(fade && settled);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const host = paneHost(pane);
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [pane]);
  return <div ref={ref} className={`pane-slot${fadeIn.current ? " pane-fade-in" : ""}`} data-slot={pane} />;
}

/** Renders each mounted pane's tree into its host. */
export function PanePortals({ bodies, mounted }: { bodies: Record<PaneId, ReactNode>; mounted: PaneId[] }) {
  return <>{mounted.map((p) => createPortal(bodies[p], paneHost(p), `pane-${p}`))}</>;
}

// --- Detached panes' windows (WS-090…096)

let terminating = false;
/** At quit, closing windows must not dock their panes (WS-093): the quit flow calls this first. */
export function noteAppTerminating() {
  terminating = true;
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", noteAppTerminating);
}

let cascadeOrigin: { x: number; y: number } | null = null;

export function DetachedPaneWindow({ pane, activate }: { pane: PaneId; activate: boolean }) {
  const tab = useActiveTab();
  const stop = useRef<(() => void)[]>([]);
  useEffect(
    () => () => {
      stop.current.forEach((s) => s());
      stop.current = [];
    },
    [],
  );
  const name = `pane-${pane}`;
  const onOpen = (win: Window) => {
    stop.current.push(trackFocusIn(win));
    if (!activate && !inTauri) window.focus();
    void auxTauriWindow(name).then((w) => {
      if (!w) return;
      const place = (own: Frame) => {
        const at = cascadeFrom(cascadeOrigin, own);
        cascadeOrigin = at;
        return at === own ? null : { ...own, ...at };
      };
      stop.current.push(autosaveFrame(w, detachedFrameKey(RAW[pane]), place));
      // Launch restore: on screen, in front of nothing (WS-096).
      if (!activate) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFocus()).catch(() => {});
    });
  };
  return (
    <AuxWindow
      name={name}
      title={paneWords.windowTitle(tab.title, PANE_NAME[pane])}
      size={L.detachedDefault}
      minSize={L.detachedMin}
      escapeCloses={false}
      onOpen={onOpen}
      onClose={() => {
        // The user closed it: closing is how a pane goes back (WS-093).
        if (!terminating) void setDetached(pane, false);
      }}
    >
      <div className="pane-window">
        <PaneSlot pane={pane} fade={false} />
      </div>
    </AuxWindow>
  );
}

/** For tests. */
export function resetHosts() {
  for (const el of hosts.values()) el.remove();
  hosts.clear();
  settled = false;
  terminating = false;
  cascadeOrigin = null;
}
