// View ▸ Animate (new in 2.1, ROADMAP Phase E; id as src/lib/menuSpec.ts names it): a check item
// that puts the active tab's canvas in animation mode, or takes it out.
import { useEffect } from "react";
import { registerCommands, type Command } from "../lib/commands";
import { activeTab } from "../workspace/store";
import { animateOn, toggleAnimate } from "./store";
import { animateWords as w } from "./words";

export const ANIMATE_COMMAND = "view:animate";

export function animateCommands(): Command[] {
  return [
    {
      id: ANIMATE_COMMAND,
      title: w.menuTitle,
      group: "View",
      keywords: [...w.keywords],
      verbs: ["animate", "play", "watch"],
      subtitle: w.menuHelp,
      checked: () => animateOn(activeTab().id),
      run: () => toggleAnimate(activeTab().id),
    },
  ];
}

/** Registers the command while the canvas is mounted. */
export function useAnimateCommands() {
  useEffect(() => registerCommands(animateCommands()), []);
}
