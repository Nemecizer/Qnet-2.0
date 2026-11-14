// The toolbar's Solve button (new in 2.1, ledger UX-111): the one primary control in the top
// bar. It runs Run ▸ Solve's own command (src/panes/results/agreement/commands.ts `run:solve`),
// so the menu, ⌘↩ and the button can't drift. With no network it stays focusable and says why it
// can't run; while a run is in progress it says so.
import { LoaderCircle, Play } from "lucide-react";
import { Icon } from "../components/Icon";
import { getCommand, runCommand, unavailableReason, useCommandList } from "../lib/commands";
import { shortcutFor } from "../lib/menu";
import { useModalOpen } from "../lib/overlays";
import { sequenceRunning, useSequence } from "../panes/results/agreement/runner";
import { useLiveRuns } from "../runs/ui/live";
import { activeTab, useWorkspace } from "../workspace/store";
import { solveButtonWords as w } from "./words";

export const SOLVE_COMMAND = "run:solve";

export function SolveToolbarButton() {
  useCommandList();
  useModalOpen();
  useSequence();
  const { live } = useLiveRuns();
  const hasNodes = useWorkspace((ws) => activeTab(ws).document.nodes.length > 0);
  const command = getCommand(SOLVE_COMMAND);
  const running = sequenceRunning() || live !== null;
  const reason = command ? unavailableReason(command) : "";
  const disabled = running || !hasNodes || reason !== null;
  const help = running
    ? w.runningHelp
    : !hasNodes
      ? w.emptyHelp
      : reason || w.help(command?.subtitle ?? w.label, shortcutFor(SOLVE_COMMAND) ?? "⌘↩");
  return (
    <button
      type="button"
      className="solve-btn"
      aria-disabled={disabled}
      aria-busy={running || undefined}
      title={help}
      data-toolbar-item="solve"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!disabled) void runCommand(SOLVE_COMMAND);
      }}
    >
      <Icon icon={running ? LoaderCircle : Play} size={14} />
      <span>{running ? w.running : w.label}</span>
      {disabled && <span className="sr-only">{`. ${help}`}</span>}
    </button>
  );
}
