// What sits over the workspace right now: the command palette, a dialog, a sheet. 0.90.34
// disabled every command that changes the document or opens a panel while a sheet or modal panel
// was up (`menuContext.anySheetPresented`, ledger MENU-198, WS-030); `modalOpen()` is that test,
// and commands use it in their `when`.
import { useSyncExternalStore } from "react";
import { invalidateMenu } from "./menu";

let palette = false;
let held = 0;
const listeners = new Set<() => void>();
// The native menu's enablement follows modalOpen(): re-resolve it whenever that changes, since a
// cancelled Save panel changes nothing else the menu would notice.
const notify = () => {
  listeners.forEach((l) => l());
  invalidateMenu();
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function openPalette() {
  if (palette) return;
  palette = true;
  notify();
}

export function closePalette() {
  if (!palette) return;
  palette = false;
  notify();
}

export function togglePalette() {
  palette = !palette;
  notify();
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => palette);
}

/** Marks a modal sheet or dialog as up until the returned function is called. */
export function holdModal(): () => void {
  held++;
  notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    held--;
    notify();
  };
}

let asking = 0;

/** True while a dialog, sheet or the palette is up: document commands wait (MENU-198). */
export function modalOpen(): boolean {
  return held > 0 || (palette && asking === 0);
}

/**
 * `question` answered as it will be once the palette has closed. The palette closes before it
 * runs a command, so its being up is no reason a command it lists cannot run: without this,
 * every command whose `when` asks `modalOpen()` was dimmed in the palette ("Close the open dialog
 * first") and could not be chosen there. A dialog or sheet under the palette still counts.
 */
export function asideFromPalette<T>(question: () => T): T {
  asking++;
  try {
    return question();
  } finally {
    asking--;
  }
}

/** The sentence a command's `when` gives while something modal is up. */
export const MODAL_REASON = "Close the open dialog first";

export function useModalOpen(): boolean {
  return useSyncExternalStore(subscribe, modalOpen);
}

/** For tests: back to nothing open. */
export function resetOverlays() {
  asking = 0;
  palette = false;
  held = 0;
  notify();
}
