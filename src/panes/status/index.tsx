// The Status pane and what goes with it: the active tab's log (filter, search, copy, clear and
// undo-clear, save), the flag bar, and the silent analysis that feeds the flags (ledger 11.1, 11.2,
// ANA-015, ANA-020…027).
import { useEffect } from "react";
import { getCommand, useCommands } from "../../lib/commands";
import { getWorkspace, onWorkspaceChange, setLog, tabById } from "../../workspace/store";
import { startSilentAnalysis } from "./analysis";
import { makeEntry } from "./entries";
import { saveStatusLog } from "./exportLog";
import { clearStatusLog, forgetClosedTabs } from "./state";
import { statusWords as w } from "./words";

export { StatusPane } from "./StatusPane";
export { FlagBar } from "./FlagBar";
export { analyseTab, analysisOf, hasBeenAnalyzed, recordAnalysis, useAnalysis, useStationUtilisation } from "./analysis";
export { decodeStatusEntry, formattedLine, inferSeverity } from "./entries";
export { statusWords } from "./words";

/**
 * Every new tab's log starts with 0.90.34's greeting (ledger LOG-001), and a restored or reopened
 * tab whose saved log is empty gets it too (`if !statusLog.isEmpty`). A tab seen for the first time
 * with an empty log is greeted, as of that moment, above anything logged in the same turn.
 * (Until the workspace store's blank tab carries the greeting itself.)
 */
export function startGreeting(): () => void {
  const seen = new Set<string>();
  const greet = (ids: string[]) => {
    const at = Date.now();
    queueMicrotask(() => {
      for (const id of ids) {
        const t = tabById(id);
        if (t && !t.log.some((e) => e.text === w.greeting && e.date <= at)) setLog(id, [makeEntry(w.greeting, "info", at), ...t.log]);
      }
    });
  };
  const look = () => {
    const fresh: string[] = [];
    for (const t of getWorkspace().tabs) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (!t.log.length) fresh.push(t.id);
    }
    if (fresh.length) greet(fresh);
  };
  look();
  return onWorkspaceChange(() => {
    look();
    forgetClosedTabs();
  });
}

/** Edit ▸ Clear Status Log, File ▸ Export ▸ Status Log…, and the silent analysis's triggers. */
export function useStatusCommands() {
  useEffect(() => startGreeting(), []);
  useEffect(() => startSilentAnalysis(), []);
  useCommands(
    [
      {
        id: "edit:clear-status-log",
        title: w.clearCommandTitle,
        subtitle: w.clearCommandHelp,
        group: "Edit",
        keywords: ["status", "log", "empty"],
        when: () => (tabById(getWorkspace().activeId)?.log.length ? true : w.logEmpty),
        run: () => clearStatusLog(getWorkspace().activeId),
      },
      {
        id: "file:export-status-log",
        title: w.exportCommandTitle,
        subtitle: w.exportCommandHelp,
        group: "File",
        keywords: ["save", "status", "log", "text"],
        when: () => (tabById(getWorkspace().activeId)?.log.length ? true : w.logEmpty),
        run: () => saveStatusLog(getWorkspace().activeId),
      },
    ],
    [],
  );
}

/** For tests: whether the pane's commands are registered. */
export const statusCommandsRegistered = () => !!getCommand("edit:clear-status-log") && !!getCommand("file:export-status-log");
