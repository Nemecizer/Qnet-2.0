// The Help menu's commands, the About item and the palette's Help entries (0.90.34
// QnetCommands.swift `helpMenu`, `appMenu`; ledger section 1.10, MENU-001). Ids are the ones
// src/lib/menuSpec.ts names:
//
//   help:open                Help ▸ Qnet Help (⌘?): the window, on the last topic. Always the window.
//   help:topic:<id>          a topic, for every topic in the manifest: Help ▸ Keyboard Shortcuts,
//                            SRBM MLMC Guide and Connect an AI Provider's three items are these.
//   help:ref:<id>            Help ▸ Method Reference's items (the four groups, AI Providers excluded).
//   help:release-notes       Help ▸ Release Notes.
//   app:about                Qnet ▸ About Qnet.
//   help:acknowledgements    the About window with its Acknowledgements list open (palette only).
//
// `help:topic:` and `help:ref:` are the Help menu's topic items, so they go where Settings ▸ Help
// sends Help-menu output (the window, the Status pane or the Shell: MENU-163, HELP-093). A window's
// own "?" button calls `openHelp(topic)` instead, which always opens the window.
import { useEffect } from "react";
import { useCommands, type Command } from "../../lib/commands";
import { METHOD_REFERENCE } from "../../lib/menuSpec";
import { paneWords } from "../../workspace/panes/words";
import { openAbout } from "../about";
import { openReleaseNotes } from "../releasenotes";
import { aboutWords } from "../about/words";
import { showHelpTopic } from "./destinations";
import { duplicateKeys } from "./shortcuts";
import { HELP_WINDOW, openHelp } from "./state";
import { menuHelp, TOPICS, topic } from "./topics";
import { helpWords as w } from "./words";
import { CircleHelp, Info, Keyboard, History } from "lucide-react";

/** The topics whose Help-menu item has its own words. */
const MENU_ITEM: Record<string, { title: string; help: string }> = {
  keyboardShortcuts: { title: w.menu.shortcuts, help: w.menu.shortcutsHelp },
  exactSimulation: { title: w.menu.guide, help: w.menu.guideHelp },
};

export function helpCommands(): Command[] {
  const cmds: Command[] = [
    {
      id: "help:open",
      title: w.menu.open,
      group: "Help",
      icon: CircleHelp,
      shortcut: w.shortcuts.helpKey,
      subtitle: w.menu.openHelp,
      keywords: ["documentation", "manual", "search", "reference"],
      run: () => void openHelp(),
    },
    {
      id: "help:release-notes",
      title: w.menu.releaseNotes,
      group: "Help",
      icon: History,
      subtitle: w.menu.releaseNotesHelp,
      keywords: ["changelog", "changes", "what's new", "version"],
      run: () => openReleaseNotes(),
    },
    {
      id: "app:about",
      title: aboutWords.menuTitle,
      group: "Qnet",
      icon: Info,
      subtitle: aboutWords.menuHelp,
      keywords: ["version", "build"],
      run: () => openAbout(),
    },
    {
      id: "help:acknowledgements",
      title: aboutWords.acknowledgements,
      group: "Help",
      subtitle: aboutWords.acknowledgementsHelp,
      keywords: ["licences", "licenses", "third-party", "open source", "credits"],
      run: () => openAbout({ acknowledgements: true }),
    },
  ];
  // Every topic: the full title in the palette, so the two "Spectral Method"s and the two
  // "Simulation"s read apart there as their menu tooltips told them apart.
  const inReference = new Set(METHOD_REFERENCE.flatMap(({ topics }) => topics.map(([id]) => id)));
  for (const t of TOPICS) {
    const item = MENU_ITEM[t.id];
    cmds.push({
      id: `help:topic:${t.id}`,
      // Help ▸ Method Reference lists it under its own id below: once in the palette, not twice.
      menuOnly: inReference.has(t.id) && !!topic(t.id),
      title: item?.title ?? t.windowTitle,
      group: "Help",
      groupUnsearched: true,
      ...(t.id === "keyboardShortcuts" ? { icon: Keyboard } : {}),
      subtitle: item?.help ?? menuHelp(t),
      keywords: [...t.keywords, t.title, "help"],
      run: () => showHelpTopic(t.id),
    });
  }
  // Help ▸ Method Reference: the menu's own ids, for the topics it lists.
  for (const { section, topics } of METHOD_REFERENCE) {
    for (const [id, label] of topics) {
      const t = topic(id);
      if (!t) continue;
      cmds.push({
        id: `help:ref:${id}`,
        title: label,
        group: `${w.menu.methodReference} ▸ ${section}`,
        groupUnsearched: true,
        subtitle: menuHelp(t),
        run: () => showHelpTopic(id),
      });
    }
  }
  return cmds;
}

/** Registers the Help menu, About and Release Notes. Mount once, in the app. */
export function useHelpCommands() {
  useCommands(helpCommands(), []);
  // A development build says so when two menu items share a key (0.90.34's debug-build menu
  // audit, KEY-038); the tests fail on the same check.
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === "test") return;
    const timer = setTimeout(() => {
      for (const clash of duplicateKeys()) console.error(`Qnet menu audit: two items share ${clash}`);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);
}

// Edit ▸ Find Next / Find Previous explain themselves while Help is key: "No matches in this help
// topic" when the open topic has none (QnetCommands.swift `helpFindHelp`, HELP-012). The Find
// commands (src/workspace/panes/commands.ts) read these by the focused window's name.
paneWords.findStepHelp[HELP_WINDOW] ??= w.findStepHelp;
