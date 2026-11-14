// Window ▸ Shell (MENU-154…156, WorkspaceCommands.swift) and the hooks other areas call: Edit's
// clipboard items while the Shell has focus (MENU-036, SH-038/039, INV-062) and the quit path's
// transcript save (WS-131).
import { registerCommands, type Command } from "../../lib/commands";
import { destructive } from "../../lib/dialogs";
import { api, inTauri } from "../../lib/api";
import { invalidateMenu } from "../../lib/menu";
import { focusedPane } from "../../workspace/focus";
import { reveal } from "../../workspace/panes/commands";
import { writeClipboard } from "../status/state";
import { existingShellView, shellView } from "./view";
import { shellWords as w } from "./words";

/** Restart Shell… (and the header's Restart Shell): confirms, forgets the transcript, restarts. */
export async function confirmRestartShell(target?: Document): Promise<boolean> {
  const ok = await destructive({ title: w.restartTitle, message: w.restartMessage, confirmTitle: w.restartConfirm, target });
  if (!ok) return false;
  const restarting = existingShellView()?.restart();
  await api.shellTranscriptClear().catch(() => {});
  await restarting;
  return true;
}

/** Clear Shell (⌘K): empties the pane; the shell keeps running. */
export function clearShell() {
  existingShellView()?.clear();
}

/** Window ▸ Shell ▸ Find in Shell…: reveals the pane, then opens its find bar. */
export function findInShell(): Promise<void> {
  return reveal("shell", () => shellView().showFind());
}

export function shellCommands(): Command[] {
  return [
    { id: "shell:clear", title: w.menuClear, group: "Window", subtitle: w.menuClearHelp, keywords: ["terminal", "clear"], run: clearShell },
    { id: "shell:find", title: w.menuFind, group: "Window", subtitle: w.menuFindHelp, keywords: ["terminal", "search"], run: findInShell },
    { id: "shell:restart", title: w.menuRestart, group: "Window", subtitle: w.menuRestartHelp, keywords: ["terminal", "restart"], run: () => confirmRestartShell() },
  ];
}

let unregister: (() => void) | null = null;

/** Registers Window ▸ Shell's commands (once; the pane's module does it on import). */
export function registerShellCommands() {
  unregister ??= registerCommands(shellCommands());
}

// ── Hooks for the Edit menu (src/editor/commands.ts) ──────────────────────────────────────────

/** The Shell's terminal has the keyboard. */
export function shellFocused(): boolean {
  return focusedPane() === "shell" && !!existingShellView();
}

/** Edit ▸ Copy's enablement while the Shell has focus: a selection exists (SH-039). */
export function shellHasSelection(): boolean {
  return existingShellView()?.term.hasSelection() ?? false;
}

/**
 * Edit ▸ Copy (⌘C) and the context menu: the selection, or nothing — never the whole scrollback
 * (SH-038, INV-062). Resolves to whether anything was copied.
 */
export async function copyShellSelection(): Promise<boolean> {
  const v = existingShellView();
  const text = v?.selection() ?? "";
  if (!text) return false;
  await writeClipboard(text, v!.root.ownerDocument.defaultView ?? window);
  return true;
}

/** Edit ▸ Select All in the Shell: the whole buffer (SH-042). */
export function selectAllInShell() {
  existingShellView()?.selectAll();
  invalidateMenu();
}

/** Edit ▸ Paste in the Shell: the clipboard's text into the shell, as a paste (SH-041). */
export async function pasteIntoShell(text?: string): Promise<void> {
  const v = existingShellView();
  if (!v) return;
  let t = text;
  if (t === undefined && inTauri && "isTauri" in window) {
    // AppKit's Paste into the terminal's input: xterm.js takes it as a paste (bracketed when asked).
    v.focus();
    await api.nativeEdit("paste").catch(() => {});
    return;
  }
  if (t === undefined) {
    try {
      t = await (v.root.ownerDocument.defaultView ?? window).navigator.clipboard.readText();
    } catch {
      t = "";
    }
  }
  v.paste(t ?? "");
}

// ── Hook for the quit path (src/workspace/tabs/session.ts `quit`) ─────────────────────────────

/**
 * Saves the Shell transcript, whatever the tab-restore answer (WS-131, SET-187). A launch whose
 * Shell was never shown, or that captured nothing, leaves the last session's transcript alone
 * (SH-028).
 */
export async function saveShellTranscript(): Promise<void> {
  const v = existingShellView();
  if (!v) return;
  // What is still queued for the view is drawn (and captured) first, but a quit never waits long.
  await Promise.race([v.drained(), new Promise((r) => setTimeout(r, 500))]);
  await v.save(true);
}
