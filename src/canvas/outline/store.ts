// Whether the Canvas Outline is open (one for the window: it follows the active tab's canvas).
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const outlineOpen = () => open;
export const useOutlineOpen = () => useSyncExternalStore(subscribe, () => open);
export function setOutlineOpen(on: boolean) {
  if (open === on) return;
  open = on;
  listeners.forEach((l) => l());
}
/** Tests: back to closed. */
export function resetOutline() {
  setOutlineOpen(false);
}
