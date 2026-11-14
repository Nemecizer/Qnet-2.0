// Where a Help-menu topic goes (0.90.34 QnetGUIApp.swift `showHelp(topic:)`, `printHelpToStatus`,
// `printHelpToTerminal`; ledger HELP-088…093, MENU-163, LOG-029, RUN-045): Settings ▸ Help ▸
// "Send help output to" (`help.outputDestination`) chooses the Status pane (0), the Shell pane
// (1) or the Qnet Help window (2, the default). Only the Help menu's topic items ask: Help ▸ Qnet
// Help, a window's "?" button and the Method Chooser's links always open the window (HELP-093).
//
// The Status and Shell destinations print the article as plain text (./markdown.ts `plainText`):
// 0.90.34's topics were ASCII and went out as written; 2.0's are Markdown, so they are set back
// into that shape first. The Shell destination goes through the run path under the topic's label,
// as Analyze Network does (src-tauri/src/help.rs `help_show`); nothing is typed into the shell and
// no temporary file is written (decision D1).
import { api } from "../../lib/api";
import { getSetting } from "../../lib/kv";
import { editorFeedback } from "../../editor";
import { followRun } from "../../runs/state";
import { activeTab, addStatus, getWorkspace, tabById } from "../../workspace/store";
import { openHelp } from "./state";
import { topic, topicText } from "./topics";
import { helpWords as w } from "./words";

export const DESTINATION_KEY = "help.outputDestination";
export const DESTINATION = { status: 0, shell: 1, window: 2 } as const;
export type HelpDestination = (typeof DESTINATION)[keyof typeof DESTINATION];

/** The stored destination; anything unknown is the Help window (`?? .popup`). */
export function helpDestination(): HelpDestination {
  const v = getSetting<unknown>(DESTINATION_KEY, DESTINATION.window);
  return v === DESTINATION.status || v === DESTINATION.shell ? v : DESTINATION.window;
}

/** `printHelpToStatus`: a divider with the full title, every line of the topic as its own entry, "──── end ────". */
export function printHelpToStatus(topicId: string, tabId: string = activeTab(getWorkspace()).id): boolean {
  const t = topic(topicId);
  if (!t) return false;
  addStatus(w.statusDivider(t.windowTitle), "info", tabId);
  for (const line of topicText(topicId).replace(/\n$/, "").split("\n")) addStatus(line, "info", tabId);
  addStatus(w.statusEnd, "info", tabId);
  return true;
}

/** `printHelpToTerminal`: the topic printed in the Shell pane as the run `<label>`. Resolves to whether it started. */
export async function printHelpToShell(topicId: string, tabId: string = activeTab(getWorkspace()).id): Promise<boolean> {
  const t = topic(topicId);
  const tab = tabById(tabId);
  if (!t || !tab) return false;
  const text = topicText(topicId);
  const started = await followRun(tabId, t.label, (onMessage) => api.helpShow({ tabId, title: tab.title, label: t.label, text }, onMessage));
  // Another run holds the slot: its refusal is in the Status log, and the app beeps.
  if (!started) editorFeedback.beep();
  return started;
}

/** A Help-menu topic item: to the destination Settings names. Resolves to whether the topic was shown. */
export async function showHelpTopic(topicId: string): Promise<boolean> {
  if (!topic(topicId)) return false;
  switch (helpDestination()) {
    case DESTINATION.status:
      return printHelpToStatus(topicId);
    case DESTINATION.shell:
      return printHelpToShell(topicId);
    default:
      return openHelp(topicId);
  }
}
