// The analysis area (PLAN.md §7 P6): Network ▸ Network Model…, Analyze Network and Show Network
// Primitives; Run ▸ Choose a Method…; Help ▸ Check Dependencies… and the launch-time checklist.
// The lead mounts `<AnalysisHost />` once in App.tsx, calls `useAnalysisCommands()` beside the
// other areas' command hooks, and runs `startupDependencyCheck()` once at launch.
//
// Gating, as 0.90.34's menus had it (QnetCommands.swift): the Network items and Choose a Method…
// need a network and no sheet up; Check Dependencies… is never dimmed.
import { useEffect } from "react";
import { useCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { networkWords } from "../network/words";
import { activeTab } from "../workspace/store";
import { MethodChooserHost, openMethodChooser } from "../windows/methodchooser";
import { NetworkModelHost, openNetworkModel } from "../windows/networkmodel";
import { openDependencyCheck, startupDependencyCheck } from "./deps";
import { analyzeNetwork, showNetworkPrimitives } from "./report";
import { StartupCheckHost } from "./StartupCheck";
import { analysisWords as w } from "./words";

export { analyzeNetwork, showNetworkPrimitives, showReport } from "./report";
export { openDependencyCheck, startupDependencyCheck } from "./deps";
export { analysisWords } from "./words";

/** A network and no sheet up (`!hasNetwork || sheetPresented`). */
const networkAndNoSheet = (): true | string => {
  if (modalOpen()) return MODAL_REASON;
  return activeTab().document.nodes.length ? true : networkWords.noNetwork;
};

export function analysisCommands(): Command[] {
  return [
    { id: "network:model", title: w.modelTitle, group: "Network", subtitle: w.modelHelp, keywords: ["outline", "blocking", "capacity", "routes"], when: networkAndNoSheet, run: () => openNetworkModel() },
    { id: "network:analyze", title: w.analyzeTitle, group: "Network", subtitle: w.analyzeHelp, keywords: ["stability", "report", "heavy traffic"], when: networkAndNoSheet, run: () => analyzeNetwork() },
    { id: "network:primitives", title: w.primitivesTitle, group: "Network", subtitle: w.primitivesHelp, keywords: ["srbm", "drift", "covariance", "reflection"], when: networkAndNoSheet, run: () => showNetworkPrimitives() },
    { id: "run:choose-method", title: w.chooseTitle, group: "Run", subtitle: w.chooseHelp, keywords: ["advice", "which method", "recommend"], when: networkAndNoSheet, run: () => openMethodChooser() },
    { id: "help:check-dependencies", title: w.checkTitle, group: "Help", subtitle: w.checkHelp, keywords: ["python", "homebrew", "solvers", "startup"], run: () => openDependencyCheck() },
  ];
}

/** Registers the area's menu commands. */
export function useAnalysisCommands() {
  useCommands(analysisCommands(), []);
}

/** Runs the launch-time checklist once (a source-tree run only). */
export function useStartupDependencyCheck() {
  useEffect(() => {
    void startupDependencyCheck();
  }, []);
}

/** The area's windows: the Method Chooser, the Network Model window and the startup checklist. */
export function AnalysisHost() {
  return (
    <>
      <MethodChooserHost />
      <NetworkModelHost />
      <StartupCheckHost />
    </>
  );
}
