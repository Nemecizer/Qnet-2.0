// Run ▸ Transient… (new in 2.1, ROADMAP D4): the command opens the Results pane on its Transient
// view. Registered once per page by the Results pane's module, as the sweep's is.
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { reveal } from "../workspace/panes/commands";
import { activeTab } from "../workspace/store";
import { showTransientView } from "./store";
import { transientWords as w } from "./words";

export const TRANSIENT_COMMAND = "run:transient";

/** Why the command is dimmed now, or true. */
export function transientWhen(): true | string {
  if (modalOpen()) return MODAL_REASON;
  if (!activeTab().document.nodes.length) return w.noNetwork;
  return true;
}

export function transientCommands(): Command[] {
  return [
    {
      id: TRANSIENT_COMMAND,
      title: w.menuTitle,
      group: "Run",
      subtitle: w.commandHelp,
      keywords: w.keywords,
      when: transientWhen,
      run: () => {
        showTransientView();
        void reveal("results", () => {}).catch(() => {});
      },
    },
  ];
}

let started = false;

/** Registers the command once per page. */
export function startTransientCommands(): void {
  if (started) return;
  started = true;
  registerCommands(transientCommands());
}
