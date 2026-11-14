// The Shell pane's words, 0.90.34's exactly where it had them (ContentView.swift
// `TerminalPaneView`, TerminalConsoleView.swift, WorkspaceCommands.swift, DSButtons.swift).
// The lead re-exports them from src/lib/vocabulary.ts.

const grouped = (n: number) => n.toLocaleString("en-US");

export const shellWords = {
  title: "Shell",
  paneLabel: "Shell pane",
  terminalLabel: "Shell",
  terminalHelp: "Interactive shell. Solver runs print their output here.",
  vScrollLabel: "Shell vertical scroll bar",
  hScrollLabel: "Shell horizontal scroll bar",

  // Header (leading)
  running: "Shell running",
  exited: "Shell exited",
  directoryHelp: (path: string) => `Current directory: ${path}`,
  directoryLabel: (path: string) => `Current directory ${path}`,
  restartNow: "Restart",
  restartNowHelp: "Start a new shell session",
  restartNowLabel: "Restart shell",

  // Header (trailing), in 0.90.34's order
  scrollToBottom: "Scroll to Bottom",
  scrollToBottomHelp: "Scroll to the prompt",
  find: "Find in Shell",
  findHelp: (key: string) => `Find in the scrollback (${key} while the shell has focus)`,
  copy: "Copy",
  copied: "Copied",
  copyHelp: "Copy the selection, or the whole scrollback when nothing is selected",
  fontMenuHelp: "Shell font",
  systemMono: "System Monospaced",
  smaller: "Decrease Text Size",
  smallerHelp: "Decrease text size (⌥⌘− or ⌘− while this pane has focus)",
  bigger: "Increase Text Size",
  biggerHelp: "Increase text size (⌥⌘= or ⌘= while this pane has focus)",
  clear: "Clear Shell",
  clearHelp: (key: string) => `Clear the screen and scrollback (${key}). The shell keeps running.`,
  restart: "Restart Shell",
  restartHelp: "Restart the shell and forget the saved transcript…",
  more: "More Shell controls",
  moreHelp: "Shell font and text size",
  shellFont: "Shell Font",

  // Copy is never silent (the Status log)
  copiedSelection: (n: number) => `Copied ${grouped(n)} characters from the shell selection.`,
  copiedAll: (n: number) => `Copied ${grouped(n)} characters — the whole shell scrollback (nothing was selected).`,
  nothingToCopy: "Nothing to copy from the shell.",

  // Window ▸ Shell
  menuClear: "Clear Shell",
  menuClearHelp: "Empty the Shell pane without restarting the shell process",
  menuFind: "Find in Shell…",
  menuFindHelp: "Search the Shell scrollback",
  menuRestart: "Restart Shell…",
  menuRestartHelp: "Terminate and relaunch the shell process (confirms first)",

  // Restart Shell… (WorkspaceCommands.confirmRestartShell)
  restartTitle: "Restart the shell?",
  restartMessage: "The running shell process will be terminated and the saved transcript will not be restored on the next launch. To only empty the screen, use Clear Shell (⌘K) instead.",
  restartConfirm: "Restart Shell",

  // Context menu (makeContextMenu)
  ctxCopy: "Copy",
  ctxPaste: "Paste",
  ctxSelectAll: "Select All",
  ctxFind: "Find in Shell…",
  ctxScrollToBottom: "Scroll to Bottom",
  ctxClear: "Clear Shell",

  // Edit ▸ Find while the Shell has focus (MENU-046)
  findTitle: "Find in Shell…",

  // The find bar (2.0's own; SwiftTerm's was AppKit's)
  findField: "Find in the Shell scrollback",
  findPlaceholder: "Find",
  findNext: "Next Match",
  findNextHelp: "Next match (⌘G, or Return)",
  findPrevious: "Previous Match",
  findPreviousHelp: "Previous match (⇧⌘G, or ⇧Return)",
  findClose: "Done",
  findCloseHelp: "Close the find bar (Escape)",
  noMatches: "No matches",

  // The replayed transcript (replaySavedTranscript)
  separator: (when: string) => `──── previous session above — new session ${when} ────`,

  /** The shell couldn't be started at all. */
  startFailed: (why: string) => `The shell could not be started: ${why}`,
} as const;

/** `DateFormatter.localizedString(from:dateStyle: .short, timeStyle: .short)`. */
export function shortDateTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(d);
}
