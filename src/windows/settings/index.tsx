// The Settings window: 13 panes, search, reset, export and import, over the settings store
// (ledger section 6). Qnet ▸ Settings… (⌘,) opens it, or brings it forward when it is open
// (MENU-002); other windows open it on a given pane with `openSettings(pane)` (SET-026). It is an
// auxiliary window rendered from the main window's React tree (src/lib/auxWindow.tsx), 760 × 600
// at first, never smaller than 704 × 520, and as large as the user likes (SET-027); its size is
// kept in state.json under 0.90.34's `WindowFrame.QnetSettingsWindow` (SET-028, SET-209).
import { useRef, useSyncExternalStore } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { AuxWindow, raiseAuxWindow } from "../../lib/auxWindow";
import { useCommands } from "../../lib/commands";
import { getStateValue } from "../../lib/kv";
import { auxTauriWindow, autosaveFrame } from "../../workspace/layout/frames";
import { parseRect } from "../../workspace/tabs/frame";
import { SettingsView } from "./SettingsView";
import type { PaneId } from "./registry";
import { settingsWords } from "./words";
import "./settings.css";

export type { PaneId } from "./registry";

/** The state.json key of the window's size (0.90.34 kept its frame under this name). */
export const FRAME_KEY = "WindowFrame.QnetSettingsWindow";
export const SETTINGS_SIZE: [number, number] = [760, 600];
export const SETTINGS_MIN_SIZE: [number, number] = [704, 520];

let isOpen = false;
let request: { pane: PaneId; token: number } | null = null;
let token = 0;
const listeners = new Set<() => void>();
let version = 0;
const publish = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Opens Settings, or brings it forward; on `pane` when one is given. */
export function openSettings(pane?: PaneId) {
  if (pane) request = { pane, token: ++token };
  if (isOpen && raiseAuxWindow("settings")) {
    publish();
    return;
  }
  isOpen = true;
  publish();
}

/** Whether the Settings window is open. */
export function settingsOpen(): boolean {
  return isOpen;
}

function closeSettings() {
  isOpen = false;
  publish();
}

/** For tests: closed, with no pending pane. */
export function resetSettingsWindow() {
  isOpen = false;
  request = null;
  publish();
}

/** The size the window opens at: the saved frame's (SET-028), else 0.90.34's default. */
function savedSize(): [number, number] {
  const f = parseRect(getStateValue<unknown>(FRAME_KEY, null));
  if (f && f.w > 200 && f.h > 200) return [Math.max(SETTINGS_MIN_SIZE[0], Math.round(f.w)), Math.max(SETTINGS_MIN_SIZE[1], Math.round(f.h))];
  return SETTINGS_SIZE;
}

/** Mounts the Settings window while it is open. */
export function SettingsHost() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const winRef = useRef<Window | null>(null);
  const stopFrame = useRef<(() => void) | null>(null);
  if (!isOpen) return null;
  const close = () => {
    const win = winRef.current;
    // A field being edited commits its value before the window goes (ledger SET-029).
    const active = win && !win.closed ? win.document.activeElement : null;
    if (active instanceof (win as Window & typeof globalThis).HTMLElement) active.blur();
    stopFrame.current?.();
    stopFrame.current = null;
    winRef.current = null;
    closeSettings();
  };
  return (
    <AuxWindow
      name="settings"
      title={settingsWords.windowTitle}
      size={savedSize()}
      minSize={SETTINGS_MIN_SIZE}
      onOpen={(win) => {
        winRef.current = win;
        // The frame (position and size) is saved on every move and resize and restored when the
        // window opens, under 0.90.34's key (SET-028, SET-209), as the detached panes' are.
        void auxTauriWindow("settings").then((w) => {
          if (w && winRef.current === win) stopFrame.current = autosaveFrame(w, FRAME_KEY);
        });
      }}
      onClose={close}
    >
      <SettingsView doc={winRef.current?.document} onClose={close} request={request} />
    </AuxWindow>
  );
}

/** Qnet ▸ Settings… (⌘,) and Settings' own commands. */
export function useSettingsCommands() {
  useCommands(
    [
      {
        id: "app:settings",
        title: "Settings…",
        group: "Qnet",
        icon: SettingsIcon,
        keywords: ["preferences", "options", "configuration"],
        run: () => openSettings(),
      },
    ],
    [],
  );
}
