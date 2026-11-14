// How the files area writes to a tab's Status log: 0.90.34's `addStatus(_:)` without a severity,
// which inferred one from the words (StatusLog.swift `StatusEntry.inferSeverity`), and
// `reportBlocked` (QnetGUIApp.swift), which opens a hidden Status pane before writing to it.
import { getCommand, runCommand } from "../../lib/commands";
import { addStatus, type Severity } from "../store";

/** 0.90.34 `StatusEntry.inferSeverity`: one copy, in src/panes/status/entries.ts. */
export { inferSeverity } from "../../panes/status/entries";

/** Opens the Status pane when it is hidden (View ▸ Panes ▸ Status, the panes area's command). */
function revealStatus() {
  const c = getCommand("view:pane-status");
  if (!c?.checked) return;
  try {
    if (!c.checked()) void runCommand("view:pane-status");
  } catch {
    // The panes area isn't ready: write to the log all the same.
  }
}

/**
 * 0.90.34 `reportBlocked`: shows the Status pane, writes `summary`, and under it each line of
 * `detail` indented as info, unless the summary already says it.
 */
export function reportBlocked(summary: string, opts: { detail?: string; severity?: Severity; tabId?: string } = {}) {
  revealStatus();
  addStatus(summary, opts.severity ?? "error", opts.tabId);
  const trimmed = opts.detail?.trim();
  if (!trimmed || summary.includes(trimmed)) return;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text) addStatus(`    ${text}`, "info", opts.tabId);
  }
}
