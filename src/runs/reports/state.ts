// Which failure report is open, and the Status line that opens it (new in 2.0, ROADMAP A4).
// A failed run sends `report` just before `finished` (src-tauri/src/runs.rs): the run's failure
// line in its tab's Status log gains "Show Report…" (src/panes/status/actions.ts). 0.90.34's
// sentence is not changed. A run that failed without a failure line of its own (the solver exited
// 0 but its output could not be used) gets one line here to carry the action.
import { useSyncExternalStore } from "react";
import type { RunReportMessage } from "../../lib/types";
import { setStatusAction } from "../../panes/status/actions";
import { addStatus, tabById } from "../../workspace/store";
import { displayLabel } from "../ui/words";
import { reportWords as w } from "./words";

export interface OpenReport {
  /** The report's id (its folder's name). */
  id: string;
  /** The tab whose run failed; Try <method> runs there. */
  tabId: string;
}

let current: OpenReport | null = null;
const latest = new Map<string, string>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Opens the Failure Report panel on report `id`. */
export function openReport(id: string, tabId: string) {
  current = { id, tabId };
  notify();
}

export function closeReport() {
  if (!current) return;
  current = null;
  notify();
}

export function useOpenReport(): OpenReport | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** The newest report of a tab's runs this session, or null. */
export const latestReport = (tabId: string): string | null => latest.get(tabId) ?? null;

/** A run of `method` for `tabId` failed and its report was written: its Status line gains the action. */
export function noteFailureReport(tabId: string, method: string, m: RunReportMessage) {
  latest.set(tabId, m.id);
  const find = () => {
    const log = tabById(tabId)?.log ?? [];
    for (let i = log.length - 1; i >= 0; i--) if (m.statusText !== null && log[i].text === m.statusText) return log[i];
    return undefined;
  };
  let entry = find();
  if (!entry) {
    addStatus(w.statusLine(displayLabel(method)), "error", tabId);
    entry = tabById(tabId)?.log.at(-1);
  }
  if (entry) setStatusAction(entry.id, { label: w.showReport, help: w.showReportHelp, run: () => openReport(m.id, tabId) });
}

/** For tests. */
export function resetReports() {
  current = null;
  latest.clear();
  notify();
}
