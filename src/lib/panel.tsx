// Movable dialog panels (0.90.34 DSPanelWindow.swift, ledger WS-101…104, SET-206): a form hosted
// in a real window, draggable and resizable within its size band, remembered where the user left
// it, and able to stay open while the canvas underneath is scrolled. Built on AuxWindow, so it
// renders from the main window's React tree and sees the same stores.
//
// Modality, as 0.90.34 had it (none runs a modal event loop):
// - "modeless": every command stays live.
// - "document": the panel answers for the document; commands that would open another dialog wait
//   (MENU-198) — `holdModal()` for its lifetime. 0.90.34 also made it an AppKit child window of the
//   canvas window; a WebKit-opened window can't be re-parented from the page, so 2.0's is a plain
//   window (ledger WS-102, Changed).
// - "app": the same, and the window floats above every Qnet window (always on top).
//
// One panel per id: `isPanelOpen`, `bringPanelForward` and `rebandPanel` act on the open one, so a
// caller asking for a panel that is already up raises it instead of stacking a copy (WS-101), and a
// form that changes shape moves to another band without being rebuilt (WS-104).
//
// A form may refuse the window's own close paths (its close button, ⌘W, Quit) with `closeGuard`, to
// ask about an unsaved draft (WS-103, `DSPanelCloseGuard`): the guard returns false, puts its prompt
// up, and later closes the panel itself by unmounting it. A close made by the app (unmounting the
// PanelWindow) is never refused and never runs `onClose`.
//
// The frame is saved in state.json under `WindowFrame.QnetPanel.<id>` (SET-206).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AuxWindow, auxWindow, raiseAuxWindow } from "./auxWindow";
import { holdModal } from "./overlays";
import { auxTauriWindow, autosaveFrame } from "../workspace/layout/frames";

export type PanelModality = "modeless" | "document" | "app";

export const panelFrameKey = (id: string) => `WindowFrame.QnetPanel.${id}`;

/** `DSSheetSize`: the size band every form is written against (DesignSystem.swift's sheet sizes). */
export type PanelBand = "compact" | "regular" | "tall" | "wide" | "table";

export interface BandSize {
  minWidth: number;
  idealWidth: number;
  maxWidth: number;
  minHeight: number;
  idealHeight: number;
  maxHeight: number;
}

export const PANEL_BANDS: Record<PanelBand, BandSize> = {
  compact: { minWidth: 500, idealWidth: 560, maxWidth: 720, minHeight: 360, idealHeight: 400, maxHeight: 600 },
  regular: { minWidth: 500, idealWidth: 560, maxWidth: 720, minHeight: 424, idealHeight: 544, maxHeight: 800 },
  tall: { minWidth: 500, idealWidth: 560, maxWidth: 720, minHeight: 424, idealHeight: 600, maxHeight: 904 },
  wide: { minWidth: 560, idealWidth: 640, maxWidth: 820, minHeight: 480, idealHeight: 624, maxHeight: 904 },
  table: { minWidth: 760, idealWidth: 800, maxWidth: 1000, minHeight: 480, idealHeight: 624, maxHeight: 904 },
};

/** `DSSheetSize.height(forRows:)`: the ideal height plus 40 pt a row, clamped into the band. */
export function heightForRows(band: PanelBand, rows: number): number {
  const b = PANEL_BANDS[band];
  return Math.min(Math.max(b.idealHeight + Math.max(0, rows) * 40, b.minHeight), b.maxHeight);
}

interface OpenPanel {
  band: PanelBand | null;
}

const panels = new Map<string, OpenPanel>();
const auxName = (id: string) => `panel-${id}`;

/** Whether the panel `id` is open. */
export function isPanelOpen(id: string): boolean {
  return panels.has(id);
}

/** Brings an open panel forward without rebuilding it; false when it isn't open. */
export function bringPanelForward(id: string): boolean {
  if (!panels.has(id)) return false;
  raiseAuxWindow(auxName(id));
  return true;
}

/** Moves an open panel onto another band; the window is resized only when its size no longer fits. */
export function rebandPanel(id: string, band: PanelBand) {
  const p = panels.get(id);
  if (!p || p.band === band) return;
  p.band = band;
  const b = PANEL_BANDS[band];
  const win = auxWindow(auxName(id))?.win;
  const clampTo = (w: number, h: number): [number, number] => [Math.min(Math.max(w, b.minWidth), b.maxWidth), Math.min(Math.max(h, b.minHeight), b.maxHeight)];
  void auxTauriWindow(auxName(id)).then(async (w) => {
    if (!w) {
      if (win && !win.closed) {
        const [cw, ch] = clampTo(win.innerWidth, win.innerHeight);
        if (cw !== win.innerWidth || ch !== win.innerHeight) win.resizeTo(cw, ch);
      }
      return;
    }
    try {
      const { LogicalSize } = await import("@tauri-apps/api/dpi");
      await w.setMinSize(new LogicalSize(b.minWidth, b.minHeight));
      await w.setMaxSize(new LogicalSize(b.maxWidth, b.maxHeight));
      const scale = await w.scaleFactor();
      const inner = (await w.innerSize()).toLogical(scale);
      const [cw, ch] = clampTo(inner.width, inner.height);
      if (cw !== inner.width || ch !== inner.height) await w.setSize(new LogicalSize(cw, ch));
    } catch {
      // A window that went away mid-reband.
    }
  });
}

export interface PanelWindowProps {
  /** `[a-z0-9-]`: "node-parameters", "canvas-export", "archetype-gallery", "find-node". */
  id: string;
  title: string;
  /** Opening size; defaults to the band's ideal size. */
  size?: [number, number];
  minSize?: [number, number];
  /** The size band: the opening size, the minimum and the maximum the window can be resized to. */
  band?: PanelBand;
  /** Opening height within the band (`heightForRows`); ignored once the frame is remembered. */
  idealHeight?: number;
  modality?: PanelModality;
  /** Escape closes it; forms with an unsaved draft pass false and handle Escape themselves. */
  escapeCloses?: boolean;
  /** The window's own close (button, ⌘W, Quit) asks this first; false refuses it. */
  closeGuard?: () => boolean;
  onClose: () => void;
  onOpen?: (win: Window) => void;
  children: ReactNode;
}

export function PanelWindow({ id, title, size, minSize, band, idealHeight, modality = "document", escapeCloses = true, closeGuard, onClose, onOpen, children }: PanelWindowProps) {
  const stopFrame = useRef<(() => void) | null>(null);
  const stopClose = useRef<(() => void) | null>(null);
  const guardRef = useRef(closeGuard);
  guardRef.current = closeGuard;
  // A close the guard already agreed to (Tauri's close request) is let through once.
  const agreed = useRef(false);
  const opened = useRef(false);
  // A refused close of a window that is already gone (⌘W closes before asking) reopens it.
  const [generation, setGeneration] = useState(0);
  const b = band ? PANEL_BANDS[band] : null;
  const openSize: [number, number] = size ?? (b ? [b.idealWidth, Math.min(Math.max(idealHeight ?? b.idealHeight, b.minHeight), b.maxHeight)] : [560, 400]);
  const openMin: [number, number] | undefined = minSize ?? (b ? [b.minWidth, b.minHeight] : undefined);

  useEffect(() => (modality === "modeless" ? undefined : holdModal()), [modality]);
  useEffect(() => {
    panels.set(id, { band: band ?? null });
    return () => {
      panels.delete(id);
    };
  }, [id]);
  useEffect(
    () => () => {
      stopFrame.current?.();
      stopFrame.current = null;
      stopClose.current?.();
      stopClose.current = null;
    },
    [],
  );

  const teardownWindowHooks = () => {
    stopFrame.current?.();
    stopFrame.current = null;
    stopClose.current?.();
    stopClose.current = null;
  };

  return (
    <AuxWindow
      key={generation}
      name={auxName(id)}
      title={title}
      size={openSize}
      minSize={openMin}
      escapeCloses={escapeCloses}
      shouldClose={() => !guardRef.current || guardRef.current()}
      onClose={() => {
        teardownWindowHooks();
        // A window that never opened (window.open refused it) is not reopened: reopening would
        // fail the same way, for ever.
        const neverOpened = !opened.current;
        opened.current = false;
        if (!neverOpened && !agreed.current && guardRef.current && !guardRef.current()) {
          setGeneration((g) => g + 1);
          return;
        }
        agreed.current = false;
        onClose();
      }}
      onOpen={(win) => {
        opened.current = true;
        void auxTauriWindow(auxName(id)).then(async (w) => {
          if (!w || win.closed) return;
          stopFrame.current = autosaveFrame(w, panelFrameKey(id));
          try {
            const p = panels.get(id);
            const bandNow = p?.band ? PANEL_BANDS[p.band] : b;
            if (bandNow) {
              const { LogicalSize } = await import("@tauri-apps/api/dpi");
              await w.setMaxSize(new LogicalSize(bandNow.maxWidth, bandNow.maxHeight));
            }
            if (modality === "app") await w.setAlwaysOnTop(true);
            const off = await w.onCloseRequested((e) => {
              if (guardRef.current && !guardRef.current()) e.preventDefault();
              else agreed.current = true;
            });
            if (win.closed) off();
            else stopClose.current = off;
          } catch {
            // The window went away, or the platform refused a size: the panel still works.
          }
        });
        onOpen?.(win);
      }}
    >
      {children}
    </AuxWindow>
  );
}
