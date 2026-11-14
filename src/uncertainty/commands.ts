// Run ▸ Uncertainty… (new in 2.1, ROADMAP D7): the command opens the Results pane on its
// Uncertainty view. Registered once per page by the Results pane's module, as Sensitivity's is.
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { reveal } from "../workspace/panes/commands";
import { activeTab } from "../workspace/store";
import { uncertainParameters } from "./model";
import { showUncertaintyView } from "./store";
import { uncertaintyWords as w } from "./words";

export const UNCERTAINTY_COMMAND = "run:uncertainty";

/** Why the command is dimmed now, or true. */
export function uncertaintyWhen(): true | string {
  if (modalOpen()) return MODAL_REASON;
  const doc = activeTab().document;
  if (!doc.nodes.length) return w.noNetwork;
  if (!uncertainParameters(doc).length) return w.nothingToVary;
  return true;
}

export function uncertaintyCommands(): Command[] {
  return [
    {
      id: UNCERTAINTY_COMMAND,
      title: w.menuTitle,
      group: "Run",
      subtitle: w.commandHelp,
      keywords: w.keywords,
      when: uncertaintyWhen,
      run: () => {
        showUncertaintyView();
        void reveal("results", () => {}).catch(() => {});
      },
    },
  ];
}

let started = false;

/** Registers the command once per page. */
export function startUncertaintyCommands(): void {
  if (started) return;
  started = true;
  registerCommands(uncertaintyCommands());
}
