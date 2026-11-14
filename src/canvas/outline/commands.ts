// View ▸ Canvas Outline (new in 2.1, ledger WF-604; id as src/lib/menuSpec.ts names it).
import { useEffect } from "react";
import { registerCommands, type Command } from "../../lib/commands";
import { outlineOpen, setOutlineOpen } from "./store";
import { outlineWords as w } from "./words";

export const OUTLINE_COMMAND = "view:canvas-outline";

export function outlineCommands(): Command[] {
  return [
    {
      id: OUTLINE_COMMAND,
      title: w.menuTitle,
      group: "View",
      keywords: [...w.keywords],
      verbs: ["outline", "list", "show"],
      subtitle: w.menuHelp,
      checked: () => outlineOpen(),
      run: () => setOutlineOpen(!outlineOpen()),
    },
  ];
}

/** Registers the command while the canvas is mounted. */
export function useOutlineCommands() {
  useEffect(() => registerCommands(outlineCommands()), []);
}
