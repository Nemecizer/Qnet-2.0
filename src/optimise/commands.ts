// Run ▸ Plan Capacity… (new in 2.1, ROADMAP D5): the command opens the Results pane on its
// Capacity view. Registered once per page by the Results pane's module, as the sweep's is. Also
// here: Apply, which changes the network to a plan as one undo step.
import { editorFor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { discoverParameters, substitute, tidy, type SweepParameter } from "../sweeps/model";
import { reveal } from "../workspace/panes/commands";
import { activeTab, tabById } from "../workspace/store";
import { param, type CapacityPlan } from "./model";
import { showCapacityView } from "./store";
import { capacityWords as w } from "./words";

export const CAPACITY_COMMAND = "run:plan-capacity";

/** Why the command is dimmed now, or true. */
export function capacityWhen(): true | string {
  if (modalOpen()) return MODAL_REASON;
  const doc = activeTab().document;
  if (!doc.nodes.length) return w.noNetwork;
  if (!doc.nodes.some((n) => n.kind === "station")) return w.noStations;
  return true;
}

export function capacityCommands(): Command[] {
  return [
    {
      id: CAPACITY_COMMAND,
      title: w.menuTitle,
      group: "Run",
      subtitle: w.commandHelp,
      keywords: w.keywords,
      when: capacityWhen,
      run: () => {
        showCapacityView();
        void reveal("results", () => {}).catch(() => {});
      },
    },
  ];
}

let started = false;

/** Registers the command once per page. */
export function startCapacityCommands(): void {
  if (started) return;
  started = true;
  registerCommands(capacityCommands());
}

/** A proposed service rate as it is written into the network: rounded up at the sixth significant digit, so the target is still met. */
export function rateToApply(rate: number): number {
  const scale = Math.pow(10, 5 - Math.floor(Math.log10(rate)));
  return tidy(Math.ceil(rate * scale * (1 - 1e-12)) / scale);
}

/** The parameter a plan sets at a station: its number of servers, or its (one) service rate. */
export function planParameter(doc: BnetDocument, plan: Pick<CapacityPlan, "decision">, stationId: string): SweepParameter | null {
  const kind = plan.decision === "rates" ? "service" : "servers";
  return discoverParameters(doc).find((p) => p.kind === kind && p.nodeId === stationId) ?? null;
}

/**
 * Changes the tab's network to `plan` as ONE undo step ("Undo Apply Capacity Plan"), through the
 * editor's own parameter mutations — so the canvas, the inspector, the analysis and the staleness
 * of results all follow as for any edit — and says what it did in the tab's Status log. True when
 * the network changed. A station the network no longer has stops everything: nothing is applied.
 */
export function applyCapacityPlan(tabId: string, plan: CapacityPlan): boolean {
  const tab = tabById(tabId);
  if (!tab || plan.cost === null) return false;
  const editor = editorFor(tabId);
  const doc: BnetDocument = tab.document;
  let next: BnetDocument = doc;
  const said: string[] = [];
  for (const s of plan.stations) {
    const changed = plan.decision === "rates" ? Math.abs(s.rate - s.rateNow) > 1e-9 * s.rateNow : s.servers !== s.serversNow;
    if (!s.free || !changed) continue;
    const p = planParameter(next, plan, s.id);
    const value = plan.decision === "rates" ? rateToApply(s.rate) : s.servers;
    const moved = p ? substitute(next, p, value) : null;
    if (!moved) {
      editor.status(w.applyGone, "warning");
      return false;
    }
    next = moved;
    said.push(plan.decision === "rates" ? w.appliedRate(s.name, param(value)) : w.appliedServers(s.name, value));
  }
  const changed = editor.performParameterEdit(w.applyUndoName, said.length ? w.applied(said) : null, () => {
    for (const after of next.nodes) {
      const before = doc.nodes.find((n) => n.id === after.id);
      if (!before || before === after) continue;
      for (const [cls, law] of Object.entries(after.serviceDistributions ?? {})) {
        const was = before.serviceDistributions?.[cls];
        if (!was || was.distribution !== law.distribution || was.distributionParameters !== law.distributionParameters) editor.updateServiceDistribution(after.id, Number(cls), law.distribution, law.distributionParameters);
      }
      if (before.distribution !== after.distribution || before.distributionParameters !== after.distributionParameters) editor.updateNodeDistribution(after.id, after.distribution, after.distributionParameters);
      if (before.numberOfServers !== after.numberOfServers) editor.updateNumberOfServers(after.id, after.numberOfServers);
    }
  });
  if (!changed) editor.status(w.applySame, "info");
  return changed;
}
