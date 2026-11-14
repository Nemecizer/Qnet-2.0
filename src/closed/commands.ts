// Closed networks' commands (new in 2.1, ROADMAP D3; ids as src/lib/menuSpec.ts names them):
// Network ▸ New Closed Cycle and Network ▸ Make Closed Network.
import { useEffect } from "react";
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { activeEditor, editorFor, type Editor } from "../editor";
import { activeTab, addTab } from "../workspace/store";
import { CYCLE_ORIGIN, closedCycle } from "./build";
import { looksClosed } from "./shape";
import { closedWords as w, suggestedPopulation } from "./words";

export { looksClosed } from "./shape";

/** Gives a network drawn without a source and a sink its population: one undoable step. */
export function makeClosed(editor: Editor, population?: number) {
  const n = population ?? suggestedPopulation(editor.nodes.filter((x) => x.kind === "station").length);
  editor.setClosedPopulation(n);
}

/**
 * The problem "never leaves" offers this (src/canvas/validation/fixes.ts): the sources and sinks go,
 * with their links, and the network gets its population — one undo group.
 */
export function convertToClosed(editor: Editor, population: number) {
  for (const n of editor.nodes.filter((x) => x.kind === "source" || x.kind === "sink")) editor.deleteNode(n.id);
  editor.setClosedPopulation(population);
  editor.undoManager.setActionName(w.undoMakeClosed);
}

const STATIONS = 3;

/** A three-station closed cycle with six customers: on the canvas when it is empty, else in a new tab. */
export function newClosedCycle(): Set<string> {
  if (activeEditor().nodes.length > 0) addTab({}, { activate: true });
  const editor = editorFor(activeTab().id);
  const { nodes, links } = closedCycle(STATIONS);
  const population = suggestedPopulation(STATIONS);
  const ids = editor.insertSubnetwork(nodes, links, true, CYCLE_ORIGIN, w.cycleAction, w.cycleDetail(STATIONS, population));
  editor.setClosedPopulation(population);
  editor.undoManager.setActionName(w.cycleAction);
  return ids;
}

export function closedCommands(): Command[] {
  const busy = (): true | string => (modalOpen() ? MODAL_REASON : true);
  return [
    { id: "network:new-closed-cycle", title: w.cycleTitle, group: "Network", subtitle: w.cycleHelp, keywords: [...w.cycleKeywords], when: busy, run: () => void newClosedCycle() },
    {
      id: "network:make-closed",
      title: w.makeClosedTitle,
      group: "Network",
      subtitle: w.makeClosedCommandHelp,
      keywords: ["closed", "population", "customers"],
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        const doc = activeTab().document;
        if (!looksClosed(doc.nodes)) return w.notClosedShape;
        return doc.closedPopulation === undefined ? true : w.alreadyClosed;
      },
      run: () => makeClosed(activeEditor()),
    },
  ];
}

/** Registers the commands while the canvas is mounted. */
export function useClosedCommands() {
  useEffect(() => registerCommands(closedCommands()), []);
}
