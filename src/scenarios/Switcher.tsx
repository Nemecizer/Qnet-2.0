// The toolbar's scenario switcher (new in 2.1, ROADMAP E1): a button that always shows the name
// of the variant on the canvas — "Baseline", or the scenario's — and opens the menu: the baseline
// and every scenario (the one shown is checked), New Scenario from Current Values…, Rename…,
// Duplicate…, Delete, Compare Scenarios…. Every item runs the command the palette runs.
import { useRef, useState } from "react";
import { Layers } from "lucide-react";
import { Icon } from "../components/Icon";
import { getCommand, runCommand, titleOf, unavailableReason, useCommandList } from "../lib/commands";
import { useModalOpen } from "../lib/overlays";
import { useSequence } from "../panes/results/agreement/runner";
import { PopupMenu, type PopupItem } from "../workspace/panes/PopupMenu";
import { useActiveTab } from "../workspace/store";
import { COMPARE_COMMAND, NEW_COMMAND, showScenario, startScenarioCommands } from "./commands";
import { activeScenario, scenariosOf } from "./model";
import { useSolveAll } from "./solveAll";
import { scenarioWords as w } from "./words";
import "./scenarios.css";

startScenarioCommands();

function commandItem(id: string, label: string): PopupItem {
  const c = getCommand(id);
  if (!c) return { label, disabled: true };
  const why = unavailableReason(c);
  return { label, help: why ?? c.subtitle ?? titleOf(c), disabled: why !== null, run: () => void runCommand(id) };
}

export function ScenarioSwitcher() {
  useCommandList();
  useModalOpen();
  useSequence();
  const solving = useSolveAll();
  const tab = useActiveTab();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const doc = tab.document;
  const now = activeScenario(doc);
  const name = now?.name ?? w.baseline;
  const busy = solving !== null;

  const items = (): PopupItem[] => [
    { label: w.baseline, help: w.showBaselineHelp, checked: now === null, disabled: busy, run: () => void showScenario(tab.id, null) },
    ...scenariosOf(doc).map((s): PopupItem => ({ label: s.name, help: w.showHelp(s.name), checked: s.id === now?.id, disabled: busy, run: () => void showScenario(tab.id, s.id) })),
    "-",
    commandItem(NEW_COMMAND, w.newFromCurrent),
    commandItem("scenario:rename", w.rename),
    commandItem("scenario:duplicate", w.duplicate),
    commandItem("scenario:delete", w.delete),
    "-",
    commandItem(COMPARE_COMMAND, w.compare),
  ];
  const close = (chosen?: () => void) => {
    setMenu(null);
    const back = returnTo.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
    chosen?.();
  };

  return (
    <>
      <button
        type="button"
        className={`scn-switcher${now ? " is-scenario" : ""}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={w.switcherLabel(name)}
        title={solving ? w.solving(solving.index, solving.total, solving.name) : w.switcherHelp(name, now ? now.overrides.length : null)}
        data-toolbar-item="scenario"
        data-scenario={now?.id ?? "baseline"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (menu) return close();
          returnTo.current = e.currentTarget;
          setMenu(e.currentTarget.getBoundingClientRect());
        }}
      >
        <Icon icon={Layers} size={14} />
        <span className="scn-switcher-name">{name}</span>
      </button>
      {menu && <PopupMenu items={items()} anchor={menu} onClose={close} label={w.menuLabel} />}
    </>
  );
}
