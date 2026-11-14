// Qnet Help: the window, the Help menu's commands, the three destinations a Help-menu topic can go
// to, the help buttons other windows carry, and the generated Keyboard Shortcuts reference
// (ledger sections 14.1 and 14.4, 1.10, KEY-035…038).
//
// For the app (src/App.tsx): call `useHelpCommands()` once and mount `<HelpHosts />`.
// For other areas: `openHelp(topicId?)` opens the window (always the window);
// `<HelpButton topic="…" />` is the round "?" of a window's footer.
import { createElement, Fragment } from "react";
import { AboutHost } from "../about";
import { ReleaseNotesHost } from "../releasenotes";
import { HelpHost } from "./HelpWindow";

export { HelpHost, HelpView, HELP_FRAME_KEY, HELP_SIZE, HELP_MIN_SIZE } from "./HelpWindow";
export { HelpButton, SettingsHelpButton, SETTINGS_HELP, settingsHelpTopic } from "./HelpButton";
export { helpCommands, useHelpCommands } from "./commands";
export { showHelpTopic, printHelpToStatus, printHelpToShell, helpDestination, DESTINATION, DESTINATION_KEY } from "./destinations";
export { openHelp, closeHelp, helpOpen, focusHelpSearch, selectTopic, selectedTopic, setQuery, stepMatch, matchCount, helpState, resetHelpWindow, HELP_WINDOW, LAST_TOPIC_KEY } from "./state";
export { TOPICS, topic, topicBlocks, topicText, topicSource, topicMatches, sections, topicsIn, menuHelp, DEFAULT_TOPIC, type HelpTopic } from "./topics";
export { menuShortcuts, toolShortcuts, duplicateKeys, shortcutBlocks, type ShortcutEntry } from "./shortcuts";
export { parseMarkdown, plainText, dumpBlocks, capitalizedHeading, type Block, type Inline } from "./markdown";
export { helpWords, HELP_SECTIONS } from "./words";

/** The three windows this area owns: Help, About and Release Notes. */
export function HelpHosts() {
  return createElement(Fragment, null, createElement(HelpHost), createElement(AboutHost), createElement(ReleaseNotesHost));
}
