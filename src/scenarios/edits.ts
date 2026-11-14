// What the editor asks on every write (src/editor/editor.ts `write`): given the network before and
// after an edit, the document to store and the lines to say. The rule is `reconcile`'s
// (./model.ts); this adds the words, and remembers which tabs have been told that a change to the
// network itself is every scenario's — said once per tab, not at every edit.
//
// Imports nothing but the model and the words: the editor imports this.
import type { BnetDocument } from "../lib/bnet";
import { reconcile } from "./model";
import { scenarioWords as w } from "./words";

export interface EditNote {
  text: string;
  severity: "info" | "warning";
}

const toldTopology = new Set<string>();

/** Null when the document has no scenarios (the edit is stored as it is). */
export function scenarioEdit(tabId: string, prev: BnetDocument, next: BnetDocument): { doc: BnetDocument; notes: EditNote[] } | null {
  if (!prev.scenarios?.items.length) return null;
  const out = reconcile(prev, next);
  const notes: EditNote[] = out.dropped.map((d) => ({ text: w.dropped(d.name, d.count), severity: "warning" as const }));
  if (out.topology && !toldTopology.has(tabId)) {
    toldTopology.add(tabId);
    notes.push({ text: w.topologyOnce([w.baseline, ...prev.scenarios.items.map((s) => s.name)]), severity: "info" });
  }
  return { doc: out.doc, notes };
}

/** For tests: every tab may be told again. */
export function resetScenarioEdits() {
  toldTopology.clear();
}
