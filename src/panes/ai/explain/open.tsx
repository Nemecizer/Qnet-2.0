// What a citation chip opens, the starters the pane offers, and the "Explain" affordance other
// views carry (new in 2.1, ROADMAP E4). A chip never shows a number of its own: it names the
// source of the number written before it and, clicked, shows that source — the run, the station,
// the view or the Help article.
import { Sparkles } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { editorFor } from "../../../editor";
import { showCapacityView } from "../../../optimise/store";
import { bestRun, bottlenecks, currentRuns } from "../../../results/insight";
import { setSelectedRun } from "../../../results/selectedRun";
import { showSensitivityView } from "../../../sensitivity/store";
import { showSweepView } from "../../../sweeps/store";
import { showTransientView } from "../../../transient/store";
import { showUncertaintyView } from "../../../uncertainty/store";
import { goToProblem } from "../../../canvas/validation/commands";
import { openHelp } from "../../../windows/help/state";
import { reveal } from "../../../workspace/panes/commands";
import { activeTab, getWorkspace, tabById } from "../../../workspace/store";
import { showResultsView } from "../../results/agreement/view";
import type { ResultRecord } from "../../results/model";
import { setDraft } from "../model";
import { aiWords as w } from "../words";
import type { Fact } from "./facts";

const showResults = () => void reveal("results", () => {}).catch(() => {});

function selectStation(tabId: string, stationId: string | null) {
  if (!stationId || !tabById(tabId)) return;
  const editor = editorFor(tabId);
  if (editor.node(stationId)) editor.setView({ selectedNodeID: stationId, selectedNodeIDs: new Set([stationId]), selectedLinkID: null });
}

/** Shows where a cited number came from. True when there was something to show. */
export function openFact(tabId: string, fact: Fact): boolean {
  const t = fact.target;
  switch (t.kind) {
    case "run":
      setSelectedRun(tabId, t.runId);
      selectStation(tabId, t.stationId);
      showResultsView("table");
      showResults();
      return true;
    case "agreement":
      selectStation(tabId, t.stationId);
      showResultsView("agreement");
      showResults();
      return true;
    case "station":
      selectStation(tabId, t.stationId);
      return true;
    case "view":
      ({ sensitivity: showSensitivityView, capacity: showCapacityView, uncertainty: showUncertaintyView, transient: showTransientView, sweep: showSweepView })[t.view]();
      showResults();
      return true;
    case "problem": {
      if (!tabById(tabId)) return false;
      return goToProblem(editorFor(tabId), { severity: "info", code: "", nodeIds: t.nodeId ? [t.nodeId] : [], linkIds: t.linkId ? [t.linkId] : [], values: {} });
    }
    case "help":
      return openHelp(t.topic);
    case "none":
      return false;
  }
}

// ── Starters ────────────────────────────────────────────────────────────────────────────────────

export interface StarterContext {
  /** The tab has a network drawn. */
  hasNetwork: boolean;
  /** Finished runs of the tab (any version of the network: the tools read which still apply). */
  runs: readonly ResultRecord[];
}

/** The prompts the empty pane offers for a tab, the most useful first; the model's own three for an empty canvas. */
export function startersFor(ctx: StarterContext): string[] {
  if (!ctx.hasNetwork) return [...w.starterPrompts];
  const s = w.starters;
  const runs = currentRuns(ctx.runs, null);
  const best = bestRun(runs);
  if (!best) return [s.next, s.method(null), w.starterPrompts[0]];
  const top = bottlenecks(best);
  return [s.explain, ...(top.length === 1 ? [s.bottleneck(top[0].stationName)] : []), s.next, s.sure, s.methods, s.method(best.method.displayName)];
}

export type ExplainAbout = "agreement" | "problem" | "result";

/**
 * Opens the assistant on the tab in front with the right question in the message field, ready to
 * send (it is not sent for the person: a request goes to a provider only when they press Return).
 */
export function explainWithAssistant(about: ExplainAbout, detail?: string): void {
  const s = w.starters;
  const text = about === "agreement" ? s.sure : about === "problem" ? s.problem(detail ?? "") : s.explain;
  if (!tabById(activeTab(getWorkspace()).id)) return;
  setDraft(text);
  void reveal("ai").catch(() => {});
}

/** The small "Explain" button a banner or a popover carries. */
export function ExplainButton({ about, detail }: { about: ExplainAbout; detail?: string }) {
  return (
    <button type="button" className="btn ai-explain" title={w.explainHelp} aria-label={w.explainLabel[about]} data-explain={about} onClick={() => explainWithAssistant(about, detail)}>
      <Icon icon={Sparkles} size={12} aria-hidden />
      {w.explain}
    </button>
  );
}
