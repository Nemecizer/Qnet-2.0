// The one-time reveal of the Results workspace after the first run (0.90.34 ContentView
// `.onReceive(.qnetResultRunDidBegin)`; ledger WS-016, SET-174): when a run of the active tab
// files a record, Results is hidden, the Shell is hidden and nothing is maximized, the workspace
// is shown and `results.autoShown` is set, so it never happens again.
//
// 2.0 learns of the record when the run ends (`onRunFinished`, the run-state seam), not at launch;
// a run stopped before its end still counts, as its record had begun.
import { getSetting, setSettings } from "../../lib/kv";
import { onRunFinished } from "../../runs/state";
import { getWorkspace } from "../../workspace/store";
import { isPaneEnabled, soloedPane, visibilityPatch } from "../../workspace/panes/model";

export const AUTO_SHOWN_KEY = "results.autoShown";

/** Whether a finished run of `tabId` that filed a record (`filed` not null) reveals Results now. */
export function shouldReveal(tabId: string, filed: string | null): boolean {
  if (filed === null) return false;
  if (tabId !== getWorkspace().activeId) return false;
  if (getSetting<unknown>(AUTO_SHOWN_KEY, false) === true) return false;
  if (soloedPane() !== null) return false;
  if (isPaneEnabled("results") || isPaneEnabled("shell")) return false;
  return true;
}

let started = false;

/** Follows finished runs for the reveal (once per page; the pane's module starts it). */
export function startAutoReveal(): void {
  if (started) return;
  started = true;
  onRunFinished((m, meta) => {
    if (!shouldReveal(meta.tabId, m.filed)) return;
    void setSettings({ [AUTO_SHOWN_KEY]: true, ...visibilityPatch({ results: true }) }).catch(() => {});
  });
}
