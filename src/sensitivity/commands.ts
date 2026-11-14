// Run ▸ Sensitivity… (new in 2.1, ROADMAP D1): the command opens the Results pane on its
// Sensitivity view. Registered once per page by the Results pane's module, as the sweep's is.
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { discoverParameters } from "../sweeps/model";
import { reveal } from "../workspace/panes/commands";
import { activeTab } from "../workspace/store";
import { showSensitivityView } from "./store";
import { sensitivityWords as w } from "./words";

export const SENSITIVITY_COMMAND = "run:sensitivity";

/** Why the command is dimmed now, or true. */
export function sensitivityWhen(): true | string {
  if (modalOpen()) return MODAL_REASON;
  const doc = activeTab().document;
  if (!doc.nodes.length) return w.noNetwork;
  if (!discoverParameters(doc).length) return w.nothingToVary;
  return true;
}

export function sensitivityCommands(): Command[] {
  return [
    {
      id: SENSITIVITY_COMMAND,
      title: w.menuTitle,
      group: "Run",
      subtitle: w.commandHelp,
      keywords: w.keywords,
      when: sensitivityWhen,
      run: () => {
        showSensitivityView();
        void reveal("results", () => {}).catch(() => {});
      },
    },
  ];
}

let started = false;

/** Registers the command once per page. */
export function startSensitivityCommands(): void {
  if (started) return;
  started = true;
  registerCommands(sensitivityCommands());
}
