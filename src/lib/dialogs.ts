// Qnet's alerts: 0.90.34's `ConfirmAlert` (the one confirmation idiom for window-level actions)
// and its one-button error reports, shown by src/components/DialogHost.tsx.
//
// House rules, kept from 0.90.34: the title is a question ending in "?"; the message says what will
// be lost and names the non-destructive alternative; the confirm button repeats the verb ("Clear
// Canvas"), never "OK"; Cancel is second, so Escape and ⌘. cancel; destructive questions use the
// warning style, plain ones the informational style. Alerts queue: a second waits for the first.
import { useSyncExternalStore } from "react";
import { holdModal } from "./overlays";

export type AlertStyle = "informational" | "warning" | "critical";

export interface AlertButton {
  /** What the promise resolves to when this button is chosen. */
  id: string;
  label: string;
  /** The default button (Return) is the first unless another says so; Escape and ⌘. choose "cancel". */
  role?: "default" | "cancel" | "destructive";
  /** A ⌘-letter that chooses it (Don’t Save is ⌘D). */
  key?: string;
}

export interface AlertRequest {
  title: string;
  message?: string;
  style?: AlertStyle;
  buttons: AlertButton[];
  /** A check box under the message ("Don't ask again"); its state comes back with the answer. */
  suppression?: string;
  /** Monospaced text under a Details disclosure (an error's detail). */
  details?: string;
  /** The window to show it in, when not the main one (an auxiliary window's document). */
  target?: Document;
}

export interface AlertAnswer {
  button: string;
  suppress: boolean;
}

export interface QueuedAlert extends AlertRequest {
  seq: number;
  settle: (a: AlertAnswer) => void;
}

let queue: QueuedAlert[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Shows an alert and resolves to the button chosen. */
export function showAlert(req: AlertRequest): Promise<AlertAnswer> {
  return new Promise((resolve) => {
    const release = holdModal();
    const entry: QueuedAlert = {
      ...req,
      seq: ++seq,
      settle: (a) => {
        queue = queue.filter((q) => q !== entry);
        release();
        notify();
        resolve(a);
      },
    };
    queue = [...queue, entry];
    notify();
  });
}

export function useAlertQueue(): QueuedAlert[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue,
  );
}

/** For tests: drops every queued alert unanswered. */
export function resetAlerts() {
  for (const q of [...queue]) q.settle({ button: "cancel", suppress: false });
}

export type SaveChoice = "save" | "discard" | "cancel";

/** The close guard (ledger WS-040, WS-041): Save / Cancel / Don’t Save. */
export async function saveChanges(documentTitle: string, hasFile: boolean): Promise<SaveChoice> {
  const a = await showAlert({
    title: `Do you want to save the changes made to “${documentTitle}”?`,
    message: hasFile
      ? "Your changes will be lost if you don’t save them."
      : "This network has never been saved. Your changes will be lost if you don’t save them; Save asks where to put the .bnet file.",
    style: "warning",
    buttons: [
      { id: "save", label: hasFile ? "Save" : "Save…", role: "default" },
      { id: "cancel", label: "Cancel", role: "cancel" },
      { id: "discard", label: "Don’t Save", role: "destructive", key: "d" },
    ],
  });
  return a.button === "save" ? "save" : a.button === "discard" ? "discard" : "cancel";
}

/** A destructive question in the warning style; resolves true when confirmed. */
export async function destructive(opts: { title: string; message: string; confirmTitle: string; cancelTitle?: string; target?: Document }): Promise<boolean> {
  return (await ask({ ...opts, style: "warning" })).confirmed;
}

/** A plain question; with `suppressionTitle`, a check box whose state comes back too. */
export async function ask(opts: {
  title: string;
  message: string;
  confirmTitle: string;
  cancelTitle?: string;
  style?: AlertStyle;
  suppressionTitle?: string;
  target?: Document;
}): Promise<{ confirmed: boolean; suppress: boolean }> {
  const a = await showAlert({
    title: opts.title,
    message: opts.message,
    style: opts.style ?? "informational",
    suppression: opts.suppressionTitle,
    target: opts.target,
    buttons: [
      { id: "confirm", label: opts.confirmTitle, role: "default" },
      { id: "cancel", label: opts.cancelTitle ?? "Cancel", role: "cancel" },
    ],
  });
  return { confirmed: a.button === "confirm", suppress: a.suppress };
}

/** A one-button report (0.90.34's `showAlert`), in the critical style for failures. */
export async function report(opts: { title: string; message?: string; details?: string; style?: AlertStyle; target?: Document }): Promise<void> {
  await showAlert({ ...opts, style: opts.style ?? "critical", buttons: [{ id: "ok", label: "OK", role: "default" }] });
}
