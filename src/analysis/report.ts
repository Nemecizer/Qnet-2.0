// Network ▸ Analyze Network (⇧⌘A) and Network ▸ Show Network Primitives (⇧⌘P), and the Primitives
// report after every open (0.90.34 QnetGUIApp.swift `analyzeNetwork`, `showNetworkPrimitives`,
// `loadNetworkFile`; ledger ANA-138…143, ANA-170…175, ANA-028, WS-111, RUN-045).
//
// In 0.90.34's order, for the active tab:
// 1. Rust computes the report and the Status lines that go before it
//    (src-tauri/src/analysis_windows/report.rs). A network without a station model is reported as
//    `reportBlocked` did: the Status pane opens and "Analyze network aborted: <reason>" is logged.
// 2. Primitives publishes its analysis as the tab's flags, warnings and tractability and marks the
//    tab analysed (ANA-173); Analyze Network leaves them alone (ANA-141).
// 3. The Status lines, their severity inferred from the words, as `addStatus(_:)` did.
// 4. The report is shown in the Shell pane through the run path: one run at a time, labelled
//    `analyze` / `primitives`, numbers not normalised, no record. A refusal (another run is
//    active) is logged by the registry with 0.90.34's sentence and beeps; otherwise
//    "Displayed network analysis." / "Displayed network primitives." follows.
//
// Step 4 needs src/runs/state.ts to follow a run that something other than `api.runStart`
// launched (so its output reaches `onRunOutput` and its progress the run segment). Until the
// lead's `followRun(tabId, method, launch)` exists there, Status lines still reach the tab, but the
// Shell does not see the bytes.
import { api } from "../lib/api";
import type { RunMessage } from "../lib/types";
import { editorFeedback } from "../editor";
import { recordAnalysis } from "../panes/status/analysis";
import * as runState from "../runs/state";
import { reportBlocked } from "../workspace/files/status";
import { activeTab, addStatus, getWorkspace, tabById } from "../workspace/store";
import { analysisWords as w } from "./words";

export type ReportKind = "analyze" | "primitives";

type Launch = (onMessage: (m: RunMessage) => void) => Promise<{ started: boolean }>;
type FollowRun = (tabId: string, method: string, launch: Launch) => Promise<boolean>;

/** Without state.ts's `followRun`: the Status lines reach the tab; the bytes go nowhere. */
const statusOnly: FollowRun = async (tabId, _method, launch) => {
  const { started } = await launch((m) => {
    if (m.kind === "status") addStatus(m.text, m.severity, tabId);
  });
  return started;
};

/** state.ts's `followRun` when the lead has added it; a fallback until then. */
export function follower(): FollowRun {
  return (runState as unknown as { followRun?: FollowRun }).followRun ?? statusOnly;
}

/** Whether the run path can carry a report's bytes to the Shell (state.ts has `followRun`). */
export const reportsReachTheShell = () => follower() !== statusOnly;

/**
 * Prepares and shows `kind` for tab `tabId` (the active tab by default). Resolves to whether the
 * report reached the run path.
 */
export async function showReport(kind: ReportKind, tabId: string = activeTab(getWorkspace()).id): Promise<boolean> {
  const tab = tabById(tabId);
  if (!tab) return false;
  const prepared = await api.analysisReport(tab.document, kind);
  if (prepared.failed) {
    reportBlocked(prepared.failed, { tabId });
    return false;
  }
  if (prepared.analysis) recordAnalysis(tabId, prepared.analysis);
  for (const line of prepared.status) addStatus(line, undefined, tabId);
  const title = tabById(tabId)?.title ?? tab.title;
  const started = await follower()(tabId, kind, (onMessage) => api.analysisReportShow({ tabId, title, kind, report: prepared.report }, onMessage));
  if (started) addStatus(kind === "analyze" ? w.displayedAnalysis : w.displayedPrimitives, undefined, tabId);
  else editorFeedback.beep();
  return started;
}

/** Network ▸ Analyze Network. */
export const analyzeNetwork = (tabId?: string) => showReport("analyze", tabId);

/**
 * Network ▸ Show Network Primitives. Also the hook P4's open path calls after every successful
 * open (src/workspace/files/documents.ts runs the `network:primitives` command, WS-111).
 */
export const showNetworkPrimitives = (tabId?: string) => showReport("primitives", tabId);
