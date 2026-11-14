// Failure reports (new in 2.0, ROADMAP A4): what a student is told when a run fails, and what the
// developer can be sent. What the lead mounts and wires:
// - `<FailureReportHost />` in App.tsx beside the other hosts;
// - `useReportCommands()` in App.tsx beside the other areas' command hooks (Help ▸ Show Failure
//   Reports…).
// src/runs/state.ts already hands every `report` message to `noteFailureReport`.
import { useCommands, type Command } from "../../lib/commands";
import { api } from "../../lib/api";
import { addStatus } from "../../workspace/store";
import { reportWords as w } from "./words";

export { FailureReportHost, reportTiming } from "./ReportPanel";
export { closeReport, latestReport, noteFailureReport, openReport, resetReports, useOpenReport } from "./state";
export { alternativeFor, explain, lastErrorLine, reportText, reportWords, tooLarge, withoutHome, type Advised } from "./words";

/** Help ▸ Show Failure Reports…: opens the reports folder in Finder. Never dimmed. */
export async function showFailureReports(): Promise<void> {
  try {
    await api.reportsReveal(null);
  } catch (e) {
    addStatus(w.revealFailed(String(e)), "error");
  }
}

export function reportCommands(): Command[] {
  return [{ id: "help:failure-reports", title: w.menuTitle, group: "Help", subtitle: w.menuHelp, keywords: ["crash", "error", "failed run", "diagnostics", "support"], run: () => showFailureReports() }];
}

/** Registers the area's menu command. */
export function useReportCommands() {
  useCommands(reportCommands(), []);
}
