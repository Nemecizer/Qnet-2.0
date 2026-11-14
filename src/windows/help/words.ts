// The Help window's words, 0.90.34's to the character (QnetHelpWindow.swift `QnetHelpView`,
// `HelpTopicDetail`; QnetCommands.swift `helpMenu`, `findTitle`, `helpFindHelp`; DSSheet.swift
// `DSSheetFooter`; QnetGUIApp.swift `printHelpToStatus`). src/lib/vocabulary.ts re-exports them.

export const helpWords = {
  windowTitle: "Qnet Help",
  // The sidebar's search field (HELP-006…008).
  searchPlaceholder: "Search help",
  searchShortcutHint: "⌘F",
  searchHelp: "Filter topics by title or body text; matches are highlighted in the page",
  /** The field's tooltip: the help text with the key (`DSSearchField.tooltip`). */
  searchTip: "Filter topics by title or body text; matches are highlighted in the page (⌘F)",
  searchLabel: "Search Help",
  clearSearch: "Clear search",
  matchSummary: (n: number) => (n === 0 ? "No topics match" : n === 1 ? "1 topic matches" : `${n} topics match`),
  emptyTitle: (q: string) => (q.trim() ? `No Results for “${q.trim()}”` : "No Results"),
  emptyMessage: "Check the spelling or try a different search.",
  // The breadcrumb's match walker (HELP-011).
  matchOf: (i: number, n: number) => `${i} of ${n}`,
  matchLabel: (i: number, n: number) => `Match ${i} of ${n}`,
  findPrevious: "Find Previous",
  findPreviousHelp: "Scroll to the previous match (⇧⌘G)",
  findNext: "Find Next",
  findNextHelp: "Scroll to the next match (⌘G)",
  // Edit ▸ Find while the Help window is key (HELP-009, HELP-012, MENU-050).
  findTitle: "Search Help…",
  /** Find Next / Find Previous while Help is key: with matches, and with none (`helpFindHelp`). */
  findStepHelp: ["Scroll to the next match in this help topic", "No matches in this help topic"] as [string, string],
  // The Help menu (QnetCommands.swift `helpMenu`).
  menu: {
    open: "Qnet Help",
    openHelp: "Open the searchable Qnet Help window",
    shortcuts: "Keyboard Shortcuts",
    shortcutsHelp: "Every key equivalent in the menu bar, plus the canvas keys that are not printed beside a menu item",
    guide: "SRBM MLMC Guide",
    guideHelp: "Open the SRBM MLMC topic (Settings ▸ Help chooses the window, Status pane or Shell)",
    releaseNotes: "Release Notes",
    releaseNotesHelp: "What changed in this build and in every earlier release",
    methodReference: "Method Reference",
    aiProviders: "Connect an AI Provider",
  },
  // The round "?" button of a sheet (DSSheetFooter, HELP-095).
  buttonTip: (windowTitle: string) => `Open Qnet Help at “${windowTitle}”`,
  buttonLabel: (windowTitle: string) => `Help about ${windowTitle}`,
  // Destinations (HELP-090, LOG-029).
  statusDivider: (windowTitle: string) => `──── ${windowTitle} ────`,
  statusEnd: "──── end ────",
  // An id nothing knows (a link in an article to a topic that is gone).
  unknownTopic: (id: string) => `Qnet Help has no topic “${id}”.`,
  missingText: "This topic's text is not in this build.",
  // An article's example network (new in 2.1): the buttons of an example block.
  example: {
    label: (name: string) => `Example network ${name}`,
    open: "Open This Example",
    openHelp: (name: string) => `Open the bundled example “${name}” in the main window, as File ▸ Open Example… does`,
    run: "Open and Run",
    runHelp: (name: string, method: string) => `Open “${name}” in the main window and start ${method} on it`,
    /** The examples folder was not found: nothing to open. */
    noExamples: "The bundled examples could not be found, so the example was not opened. The Status pane lists where Qnet looked.",
    failedTitle: "Example not opened",
    /** Open and Run while a run is active: nothing is opened. */
    busyTitle: "Example not run",
    busy: "A run is in progress. Wait for it to finish, or stop it, then try again.",
    unknownRun: (id: string) => `Qnet has no Run command “${id}”, so the example was opened but nothing was run.`,
  },
  // The Keyboard Shortcuts page's generated parts (KeyboardShortcutReference.swift `text()`).
  shortcuts: {
    toolsHeading: "CANVAS TOOLS",
    toolsLead: "Bare letters, handled by the canvas rather than the menu bar:",
    helpKey: "⌘?",
  },
};

/** The 2.1 groups that come first ("Start Here", "Results"), written for students. */
export const START_SECTIONS = ["Start Here", "Results"] as const;

/** The sidebar's groups: 2.1's two, then 0.90.34's five in its order (`HelpTopicGroup`, HELP-004). */
export const HELP_SECTIONS = [...START_SECTIONS, "Concepts", "Infinite-Buffer Methods", "Finite-Buffer Methods", "Workflows", "AI Providers"] as const;
