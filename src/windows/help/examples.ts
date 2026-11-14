// An article's example network (new in 2.1): "Open This Example" and "Open and Run".
//
// The Help window is drawn from the main window's own page (src/lib/auxWindow.tsx), so nothing has
// to be sent between windows: the example is opened by the same function File ▸ Open Example…
// ends in (`openPath`: into a blank Untitled tab, else a new tab), from the folder that panel
// starts in (`examples_locate`), and the method is started by its Run-menu command, so its
// parameter sheet and its gates are the Run menu's. The main window is brought forward first: the
// tab, a sheet, a "Load Failed" alert and a refusal's toast all appear there.
//
// Opening a network also shows its primitives through the one run slot (WS-111); a method started
// before that report has ended would be refused, so Open and Run waits for it.
import { api } from "../../lib/api";
import { getCommand, runCommand } from "../../lib/commands";
import { specItem } from "../../lib/menuSpec";
import { toast } from "../../lib/toasts";
import { onRunFinished, runActive } from "../../runs/state";
import { openPath } from "../../workspace/files/documents";
import { fileWords } from "../../workspace/files/words";
import { activeTab, addStatus } from "../../workspace/store";
import { helpWords as w } from "./words";

/** "Run Whitt QNA" → "Whitt QNA", "Run Monte Carlo…" → "Monte Carlo": the method as the Run menu names it. */
export function exampleMethodName(run: string): string {
  const label = specItem(run)?.label;
  return label ? label.replace(/^Run /, "").replace(/…$/, "") : run;
}

/** How long Open and Run waits for the opened network's primitives report before starting anyway. */
export const SETTLE_MS = { grace: 1500, cap: 8000, step: 50 };

function raiseMainWindow() {
  try {
    window.focus();
  } catch {
    // Only a convenience.
  }
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFocus()).catch(() => {});
}

/**
 * Resolves when the report that follows an open has ended (or never started), so the run slot is
 * free. Only the opened tab's own report counts: another tab's ending says nothing about this one.
 */
function primitivesSettled(): { arm: (tabId: string) => Promise<void>; cancel: () => void } {
  const ended = new Set<string>();
  const stop = onRunFinished((_m, meta) => {
    if (meta.method === "primitives") ended.add(meta.tabId);
  });
  return {
    cancel: stop,
    arm: async (tabId) => {
      const started = Date.now();
      while (!ended.has(tabId)) {
        const waited = Date.now() - started;
        if (waited >= SETTLE_MS.cap || (waited >= SETTLE_MS.grace && !runActive())) break;
        await new Promise((r) => setTimeout(r, SETTLE_MS.step));
      }
      stop();
    },
  };
}

/**
 * Opens the bundled example `name` in the main window and, when `run` names a Run-menu command,
 * starts it. Resolves to whether everything asked for happened; every failure is said in the main
 * window (an alert, a toast or the Status pane), never swallowed.
 */
export async function openHelpExample(name: string, run: string | null): Promise<boolean> {
  raiseMainWindow();
  // One run at a time: with one in progress the method would be refused after the wait, silently.
  // Say so now, before anything is opened.
  if (run !== null && runActive()) {
    toast({ kind: "error", title: w.example.busyTitle, body: w.example.busy });
    return false;
  }
  let folder: string | null = null;
  try {
    const lookup = await api.examplesLocate();
    folder = lookup.path ?? null;
    if (!folder) addStatus(fileWords.noExamples(lookup.trail), "warning");
  } catch {
    folder = null;
  }
  if (!folder) {
    toast({ kind: "error", title: w.example.failedTitle, body: w.example.noExamples });
    return false;
  }
  const settle = primitivesSettled();
  const waits = run !== null && getCommand("network:primitives") !== undefined;
  if (!(await openPath(`${folder.replace(/\/$/, "")}/${name}.bnet`))) {
    settle.cancel();
    return false;
  }
  if (run === null) {
    settle.cancel();
    return true;
  }
  // The example's tab is the one in front (`openPath` selected it).
  if (waits) await settle.arm(activeTab().id);
  else settle.cancel();
  if (!getCommand(run)) {
    toast({ kind: "error", title: w.example.failedTitle, body: w.example.unknownRun(run) });
    return false;
  }
  // The example's tab is the one in front (`openPath` selected it), so the command runs on it.
  return runCommand(run);
}
