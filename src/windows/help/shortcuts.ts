// Help ▸ Keyboard Shortcuts' generated part (0.90.34 KeyboardShortcutReference.swift `text()`;
// ledger KEY-035): one table per menu of every item that has a key now, read from the live menu
// (src/lib/menu.ts `resolveMenu`, which lays src/lib/menuSpec.ts over the registered commands), so
// the page can't disagree with the menu bar: a buffer-mode Run pair prints its key beside the
// item that is enabled for the active network, and "Stop <run>" reads as the menu reads now.
//
// Two kinds of key the 2.0 menu bar can't carry are added from the code that handles them: ⌘?
// (src/App.tsx opens Help on it; AppKit won't match Shift-/ as a menu key) and the bare tool
// letters (src/canvas/commands.ts; the Tools menu shows none).
import { TOOLS } from "../../editor";
import { toolKey } from "../../canvas/interaction/tools";
import { interactionWords } from "../../canvas/interaction/words";
import { displayAccel, resolveMenu, type MenuNode } from "../../lib/menu";
import type { PredefinedRole } from "../../lib/menuSpec";
import type { Block } from "./markdown";
import { helpWords } from "./words";

export interface ShortcutEntry {
  /** The top-level menu: "File". */
  menu: string;
  /** The item under it, submenus joined with ▸: "Export ▸ All Solver Inputs to Folder…". */
  command: string;
  /** As the menu prints it: "⇧⌘T". */
  key: string;
  /** The command's id, when the item is a command. */
  id?: string;
}

/** The standard items AppKit supplies, with the keys it gives them. */
const PREDEFINED: Partial<Record<PredefinedRole, [string, string]>> = {
  hide: ["Hide Qnet", "⌘H"],
  hideOthers: ["Hide Others", "⌥⌘H"],
  undo: ["Undo", "⌘Z"],
  redo: ["Redo", "⇧⌘Z"],
  cut: ["Cut", "⌘X"],
  copy: ["Copy", "⌘C"],
  paste: ["Paste", "⌘V"],
  selectAll: ["Select All", "⌘A"],
  minimize: ["Minimize", "⌘M"],
  fullscreen: ["Enter Full Screen", "⌃⌘F"],
};

/** Every key equivalent in the menu as it stands now, in the bar's order. */
export function menuShortcuts(menu: MenuNode[] = resolveMenu()): ShortcutEntry[] {
  const out: ShortcutEntry[] = [];
  const walk = (nodes: MenuNode[], top: string, path: string[]) => {
    for (const n of nodes) {
      if (n.type === "submenu") walk(n.items, top, [...path, n.label]);
      else if (n.type === "item" && n.accel) out.push({ menu: top, command: [...path, n.label].join(" ▸ "), key: displayAccel(n.accel), id: n.id });
      else if (n.type === "item" && n.id === "help:open") out.push({ menu: top, command: [...path, n.label].join(" ▸ "), key: helpWords.shortcuts.helpKey, id: n.id });
      else if (n.type === "predefined") {
        const p = PREDEFINED[n.role];
        if (p) out.push({ menu: top, command: [...path, p[0]].join(" ▸ "), key: p[1] });
      }
    }
  };
  for (const n of menu) if (n.type === "submenu") walk(n.items, n.label, []);
  return out;
}

/** The canvas's tool letters: [letter, the tool's menu title]. */
export function toolShortcuts(): [string, string][] {
  return TOOLS.map((t) => [toolKey(t), interactionWords.menuTitle[t]]);
}

/** Two keys on one item of the bar are a mistake (0.90.34's menu audit): the pairs that clash now. */
export function duplicateKeys(entries: ShortcutEntry[] = menuShortcuts()): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const e of entries) {
    const where = `${e.menu} ▸ ${e.command}`;
    const first = seen.get(e.key);
    if (first) out.push(`${e.key}: ${first} and ${where}`);
    else seen.set(e.key, where);
  }
  return out;
}

const width = (s: string) => [...s].length;

function table(rows: [string, string][], keyWidth: number): Block {
  const lines = rows.map(([k, what]) => k + " ".repeat(Math.max(2, keyWidth - width(k))) + what);
  return { kind: "code", level: 0, lines, text: lines.join(" ") };
}

const headline = (text: string): Block => ({ kind: "headline", depth: 2, inline: [{ t: "text", s: text }], text });

/** The generated blocks: a headline and a table per menu, then the tool letters. */
export function shortcutBlocks(): Block[] {
  const entries = menuShortcuts();
  const w = helpWords.shortcuts;
  const out: Block[] = [];
  const tools = toolShortcuts();
  const keyWidth = Math.max(10, ...entries.map((e) => width(e.key) + 2), ...tools.map(([k]) => width(k) + 2));
  const order: string[] = [];
  for (const e of entries) if (!order.includes(e.menu)) order.push(e.menu);
  for (const menu of order) {
    out.push(headline(menu.toUpperCase()), table(entries.filter((e) => e.menu === menu).map((e) => [e.key, e.command]), keyWidth));
  }
  out.push(headline(w.toolsHeading), { kind: "paragraph", level: 0, inline: [{ t: "text", s: w.toolsLead }], text: w.toolsLead }, table(tools, keyWidth));
  return out;
}
