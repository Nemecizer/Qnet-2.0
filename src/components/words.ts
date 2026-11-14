// The words of the shell's own components: toasts, the command palette, the alert sheet (moved
// out of the JSX in 2.1, ledger WF-613, so that every string a user reads lives in a words file).
import type { ToastKind } from "../lib/toasts";

export const shellWords = {
  toasts: {
    region: "Notifications",
    kind: { success: "Done", error: "Error", warning: "Warning", info: "Note", progress: "In progress" } satisfies Record<ToastKind, string>,
    /** The card's name: "Error: Could not save". */
    card: (kind: string, title: string) => `${kind}: ${title}`,
    more: (n: number) => `${n} more`,
    moreLabel: (n: number) => (n === 1 ? "Show 1 more notification" : `Show ${n} more notifications`),
    fewer: "Show fewer",
    undo: "Undo",
    dismiss: "Dismiss",
  },
  palette: {
    label: "Command palette",
    search: "Search commands",
    placeholder: "Search commands, panes and tabs",
    list: "Results",
    none: (query: string) => `No commands match “${query}”.`,
    results: (n: number) => (n === 0 ? "No results" : n === 1 ? "1 result" : `${n} results`),
    unavailable: (title: string, reason: string) => `${title}: ${reason}`,
    close: "esc",
    move: "to move",
    run: "to run",
    runKey: "return",
  },
  dialog: {
    details: "Details",
  },
  /** View ▸ Appearance (2.1, WF-612): the settings src/lib/theme.ts keeps, which had no control. */
  appearance: {
    menu: "Appearance",
    theme: { system: "Match System", light: "Light", dark: "Dark" },
    themeHelp: { system: "Follow the macOS appearance", light: "Always light", dark: "Always dark" },
    contrast: "Increase Contrast",
    contrastHelp: "Stronger borders, text and selection. On by itself when macOS has Increase Contrast on",
    motion: "Reduce Motion",
    motionHelp: "Nothing glides, fades or spins. On by itself when macOS has Reduce Motion on",
    textSize: { 0.92: "Small Text", 1: "Default Text Size", 1.12: "Large Text", 1.25: "Larger Text", 1.5: "Largest Text" } as Record<number, string>,
    textSizeHelp: "The size of all the text in Qnet's windows",
    keywords: ["appearance", "theme", "accessibility", "contrast", "motion", "animation", "text", "font", "size", "bigger", "dark mode", "light mode"],
  },
} as const;
