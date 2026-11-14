// The tabs area's words, 0.90.34's exactly where the ledger quotes them (the lead re-exports these
// from src/lib/vocabulary.ts). `key` is a shortcut as the menu shows it ("⌘W").

export const tabWords = {
  untitled: "Untitled",
  /** A file sent by Finder that couldn't be opened for a reason File ▸ Open has no alert for. */
  finderOpenFailed: (path: string, reason: string) => `Couldn't open “${path.split("/").pop() ?? path}”: ${reason}`,
  /** The window subtitle and a tab's tooltip when the network has no file (WS-003, WS-018). */
  unsavedNetwork: "Unsaved network",
  tabBarLabel: "Open networks",
  unsavedChanges: "Unsaved changes",
  closeTabLabel: (title: string) => `Close ${title}`,
  /** A tab's accessible name (0.90.34 `accessibilityLabel`). */
  tabLabel: (title: string, dirty: boolean) => `${title}${dirty ? ", edited" : ""}`,
  /** The close button's tooltip (WS-020). */
  closeDirtyHelp: (closeKey: string) => `Close tab — asks to save its unsaved changes first (${closeKey})`,
  closeCleanHelp: (closeKey: string, reopenKey: string) => `Close tab (${closeKey}); ${reopenKey} brings it back`,
  previousTab: "Previous Tab",
  nextTab: "Next Tab",
  previousTabHelp: (key: string) => `Previous Tab (${key})`,
  nextTabHelp: (key: string) => `Next Tab (${key})`,
  newNetwork: "New Network",
  newNetworkHelp: (key: string) => `New Network in a new tab (File ▸ New Network, ${key})`,
  // The tab context menu (WS-022).
  closeTab: "Close Tab",
  closeOtherTabs: "Close Other Tabs",
  closeTabsToTheRight: "Close Tabs to the Right",
  revealInFinder: "Reveal in Finder",

  // Menu tooltips (menu tooltip → palette subtitle, MENU-203).
  closeTabSubtitle: "Close the front tab (asks to save unsaved changes first), or the front auxiliary window",
  closeAllTabsSubtitle: "Close every document tab in this window, asking to save each one with unsaved changes",
  closeWindowSubtitle: "Close the whole window, tabs and all",
  nextTabSubtitle: "Bring the next document tab forward",
  previousTabSubtitle: "Bring the previous document tab forward",
  /** Window ▸ Reopen Closed Tab (WS-046). */
  reopenSubtitle: (title: string | null) => (title === null ? "No tab has been closed in this session" : `Bring back “${title}”, the last tab closed`),
  /** Window ▸ <tab> (MENU-144). */
  tabItemSubtitle: (title: string, index: number, front: boolean) => (front ? `“${title}” is the front tab` : `Bring “${title}” to the front (tab ${index})`),
  showTab: (title: string) => `Show ${title}`,

  // Why a command is dimmed (the palette shows it).
  fewerThanTwoTabs: "Only one tab is open",
  nothingToReopen: "No tab has been closed in this session",

  /** The log line a reopened tab gains (WS-047). */
  reopened: (title: string, clean: boolean) => `Reopened ${title}${clean ? "" : " with its unsaved changes"}.`,
  /** The line a restored log gains (WS-137); `when` is the short date and short time. */
  newSession: (when: string) => `──── New session — ${when} ────`,

  // The quit prompt (WS-134).
  restoreTitle: "Restore tabs on next launch?",
  restoreMessage: "Your current tabs can be reopened the next time Qnet starts. Change this later in Settings ▸ General.",
  restoreConfirm: "Restore Tabs",
  restoreCancel: "Don't Restore",
  restoreSuppress: "Do not ask again",
} as const;
