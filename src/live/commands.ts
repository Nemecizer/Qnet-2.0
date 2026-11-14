// View ▸ Live Results (new in 2.1, ROADMAP Phase D; id as src/lib/menuSpec.ts names it): a check
// item, on by default.
import { useEffect } from "react";
import { registerCommands, type Command } from "../lib/commands";
import { liveShown, setLiveShown } from "./state";
import { liveWords as w } from "./words";

export const LIVE_COMMAND = "view:live-results";

export function liveCommands(): Command[] {
  return [
    {
      id: LIVE_COMMAND,
      title: w.menuTitle,
      group: "View",
      keywords: [...w.keywords],
      subtitle: w.menuHelp,
      checked: () => liveShown(),
      run: () => setLiveShown(!liveShown()),
    },
  ];
}

/** Registers the command while the canvas is mounted. */
export function useLiveCommands() {
  useEffect(() => registerCommands(liveCommands()), []);
}
