// The inspector's "Fit from Data…" button (new in 2.1, ROADMAP D2): one under each distribution
// the node inspector edits — a source's inter-arrival law, a station's service law, or the
// service law of the class in hand. The fitted law goes into the inspector's own draft, in native
// parameters, exactly as if the family had been picked and the numbers typed: the docked pane
// then commits it as one undo step ("Edit S1 Parameters"), and the Node Parameters panel on Save.
import { ChartColumn } from "lucide-react";
import type { BnetNode } from "../lib/bnet";
import { classLabel } from "../editor";
import { Icon } from "../components/Icon";
import { asDistribution, makeDraft } from "../panes/inspector/distributions";
import type { NodeParameterDraft } from "../panes/inspector/drafts";
// The panel module makes a host of its own on first use when App.tsx has not mounted one.
import "./FitPanel";
import { openFitPanel } from "./store";
import { fitWords as w } from "./words";
import "./fit.css";

/** Puts a fitted law into the draft: the single law, or class `cls`'s. */
export function applyFittedLaw(model: NodeParameterDraft, distribution: string, parameters: string, cls?: number) {
  // Native parameters, so the fitted numbers are stored as fitted (Mean & SCV entry would
  // re-derive them from two rounded moments).
  if (cls === undefined) model.setEntryMode("native");
  else model.setClassEntryMode("native");
  const draft = makeDraft(asDistribution(distribution), parameters);
  model.update((m) => {
    if (cls === undefined) m.draft = draft;
    else m.classDrafts.set(cls, draft);
  });
}

export function FitFromDataButton({ model, node, cls }: { model: NodeParameterDraft; node: BnetNode; cls?: number }) {
  const kind = node.kind === "source" ? "source" : "station";
  const target = kind === "source" ? w.targetArrival(node.name) : cls === undefined ? w.targetService(node.name) : w.targetServiceClass(node.name, classLabel(cls));
  return (
    <div className="insp-fit-row">
      <button type="button" className="btn" data-fit-open title={w.buttonHelp} onClick={() => openFitPanel({ kind, target, apply: (d, p) => applyFittedLaw(model, d, p, cls) })}>
        <Icon icon={ChartColumn} size={12} aria-hidden /> {w.button}
      </button>
    </div>
  );
}
