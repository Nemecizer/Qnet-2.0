// Run ▸ Solve, Check with Another Method and Run Recommended Methods (new in 2.1, ROADMAP B3 and
// C3), and what the Agreement view's buttons do. Each asks the Method Chooser for the active
// network's ranking (./chooser.ts), reads it as a plan (./plan.ts) and runs it through the Run
// menu's own path, one method at a time (./runner.ts). No parameter sheet opens: a method that
// has one runs with the settings' defaults, as the sheet confirmed unchanged would.
import { registerCommands, type Command } from "../../../lib/commands";
import { MODAL_REASON, modalOpen } from "../../../lib/overlays";
import { networkWords } from "../../../network/words";
import { reloadResults, resultsFor } from "../../../runs/state";
import { currentRuns } from "../../../results/insight";
import { reveal } from "../../../workspace/panes/commands";
import { activeTab, addStatus, tabById, type Tab } from "../../../workspace/store";
import { fingerprintNow } from "../fingerprint";
import { asResult, type ResultRecord } from "../model";
import { adviceFor, cachedAdvice } from "./chooser";
import { attemptedIdentifiers, candidates, checkWhyWords, commandForLabel, hasSimulation, labelFor, pickNext, recommendedPlan, solveChoice, whyWords, type Candidate, type Choice } from "./plan";
import { liveRun } from "../../../runs/ui/live";
import { runSequence, sequenceRunning, type Sequence } from "./runner";
import { showResultsView } from "./view";
import { usesAnyFeature, usesFeature } from "../../../extended/shape";
import { extendedWords as xw } from "../../../extended/words";
import { showTransientView } from "../../../transient/store";
import { agreementWords as w } from "./words";

/**
 * Methods refused for good this session (no record says so), so Check does not offer them twice:
 * "<tab>|<fingerprint>|<identifier>". Only a refusal that stays true for the network is kept (the
 * method does not apply, or its solver is not installed: `Step.permanent`); one that passes — a
 * dialog open, another run busy, the tab closed — leaves the method on offer.
 */
const refused = new Set<string>();

interface Situation {
  tab: Tab;
  cands: Candidate[];
  records: ResultRecord[];
  fingerprint: string | null;
  attempted: Set<string>;
}

async function situation(tabId: string): Promise<Situation | null> {
  const tab = tabById(tabId);
  if (!tab) return null;
  const [advice, fingerprint] = await Promise.all([adviceFor(tab), fingerprintNow(tab.document), reloadResults(tabId)]);
  if (!advice) return null;
  const records = resultsFor(tabId).map(asResult);
  const attempted = attemptedIdentifiers(records, fingerprint);
  for (const key of refused) {
    const [t, fp, identifier] = key.split("|");
    if (t === tabId && fp === (fingerprint ?? "")) attempted.add(identifier);
  }
  return { tab, cands: candidates(advice.rows, advice.infinite), records, fingerprint, attempted };
}

/** A run (or a sweep) already owns the one run slot: nothing is started, and the tab is told. */
function busy(tabId: string): boolean {
  if (!sequenceRunning() && !liveRun()) return false;
  addStatus(w.busy, "info", tabId);
  return true;
}

const stepOf = (c: Candidate) => ({ label: c.label, command: c.command, name: c.advice.name });

function noteRefusals(s: Situation, plan: Candidate[], done: Sequence | null) {
  done?.steps.forEach((step, i) => {
    if (step.state === "refused" && step.permanent) refused.add(`${s.tab.id}|${s.fingerprint ?? ""}|${plan[i].identifier}`);
  });
}

const showAgreement = () => {
  showResultsView("agreement");
  void reveal("results", () => {}).catch(() => {});
};

/** Check with Another Method: runs the most informative method that has not run. Resolves to the method run, or null. */
export async function checkWithAnother(tabId: string = activeTab().id): Promise<Candidate | null> {
  if (busy(tabId)) return null;
  const s = await situation(tabId);
  const pick = s ? pickNext(s.cands, s.attempted, hasSimulation(currentRuns(s.records, s.fingerprint))) : null;
  if (!s || !pick) {
    addStatus(s ? w.checkNone : w.noAdvice, "info", tabId);
    return null;
  }
  showAgreement();
  noteRefusals(s, [pick.candidate], await runSequence(tabId, [stepOf(pick.candidate)]));
  return pick.candidate;
}

/** Run Recommended Methods: the exact method if any, one simulation and the top two approximations that have not run, in turn. */
export async function runRecommended(tabId: string = activeTab().id): Promise<Candidate[]> {
  if (busy(tabId)) return [];
  const s = await situation(tabId);
  if (!s) {
    addStatus(w.noAdvice, "info", tabId);
    return [];
  }
  const have = new Set(currentRuns(s.records, s.fingerprint).map((r) => r.method.identifier));
  const plan = recommendedPlan(s.cands).filter((c) => !have.has(c.identifier));
  if (!plan.length) {
    addStatus(w.recommendedNone, "info", tabId);
    return [];
  }
  showAgreement();
  noteRefusals(s, plan, await runSequence(tabId, plan.map(stepOf)));
  return plan;
}

/** Solve: runs the single best method for the network (unless its result is already there) and shows the Agreement view. */
export async function solve(tabId: string = activeTab().id): Promise<Candidate | null> {
  if (busy(tabId)) return null;
  const s = await situation(tabId);
  const pick = s ? solveChoice(s.cands) : null;
  if (!s || !pick) {
    // A network whose arrival rate changes in time (new in 2.1) has no steady state for any
    // method to compute: say so, and open the view that does answer for it.
    if (usesFeature(tabById(tabId)?.document, "timeVaryingRates")) {
      addStatus(xw.solveTimeVarying, "warning", tabId);
      showTransientView();
      void reveal("results", () => {}).catch(() => {});
      return null;
    }
    addStatus(usesAnyFeature(tabById(tabId)?.document) ? xw.solveNoMethod : w.noAdvice, "info", tabId);
    return null;
  }
  showAgreement();
  if (currentRuns(s.records, s.fingerprint).some((r) => r.method.identifier === pick.candidate.identifier)) {
    addStatus(w.solveAlready(pick.candidate.advice.name), "info", tabId);
    return pick.candidate;
  }
  noteRefusals(s, [pick.candidate], await runSequence(tabId, [stepOf(pick.candidate)]));
  return pick.candidate;
}

/** Run Them Again: the methods of the runs that went stale, for the network as it is now. */
export async function rerunStale(tabId: string = activeTab().id): Promise<string[]> {
  const tab = tabById(tabId);
  if (!tab || busy(tabId)) return [];
  await reloadResults(tabId);
  const infinite = tab.document.infiniteBuffers;
  const steps = currentRuns(resultsFor(tabId).map(asResult), null)
    .map((r) => ({ label: labelFor(r.method.identifier, infinite), name: r.method.displayName }))
    .filter((x): x is { label: string; name: string } => x.label !== null)
    .map((x) => ({ ...x, command: commandForLabel(x.label, infinite) }));
  await runSequence(tabId, steps);
  return steps.map((x) => x.label);
}

// ── What the buttons and tooltips say now ─────────────────────────────────────────────────────

/** Solve's method for the active network, when the Chooser has answered. */
export function solvePreview(tab: Pick<Tab, "id" | "document"> = activeTab()): Choice | null {
  const advice = cachedAdvice(tab);
  return advice ? solveChoice(candidates(advice.rows, advice.infinite)) : null;
}

export const solveHelp = (pick: Choice | null) => (pick ? w.solveHelp(pick.candidate.advice.name, whyWords(pick.why), pick.candidate.advice.summary) : w.solveHelpIdle);
export const checkHelp = (pick: Choice | null) => (pick ? w.checkHelp(pick.candidate.advice.name, checkWhyWords(pick.why)) : w.checkHelpIdle);

/** Check's method for a tab's records as they are, when the Chooser has answered. */
export function checkPreview(tab: Pick<Tab, "id" | "document">, records: readonly ResultRecord[], fingerprint: string | null): Choice | null {
  const advice = cachedAdvice(tab);
  if (!advice) return null;
  const attempted = attemptedIdentifiers(records, fingerprint);
  for (const key of refused) {
    const [t, fp, identifier] = key.split("|");
    if (t === tab.id && fp === (fingerprint ?? "")) attempted.add(identifier);
  }
  return pickNext(candidates(advice.rows, advice.infinite), attempted, hasSimulation(currentRuns(records, fingerprint)));
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────

const canRun = (): true | string => {
  if (modalOpen()) return MODAL_REASON;
  if (!activeTab().document.nodes.length) return networkWords.noNetwork;
  return sequenceRunning() || liveRun() ? w.busy : true;
};

export function agreementCommands(): Command[] {
  return [
    {
      id: "run:solve",
      title: w.solve,
      group: "Run",
      get subtitle() {
        return solveHelp(solvePreview());
      },
      keywords: ["run", "best method", "answer", "start", "go"],
      when: canRun,
      run: () => solve(),
    },
    {
      id: "run:check-another",
      title: w.check,
      group: "Run",
      get subtitle() {
        const tab = activeTab();
        // The fingerprint is not known here without asking Rust: every record of the tab counts as tried.
        return checkHelp(checkPreview(tab, resultsFor(tab.id).map(asResult), null));
      },
      keywords: ["verify", "cross-check", "second opinion", "agreement", "compare"],
      when: canRun,
      run: () => checkWithAnother(),
    },
    {
      id: "run:recommended",
      title: w.recommended,
      group: "Run",
      subtitle: w.recommendedHelp,
      keywords: ["all", "exact", "simulation", "approximations", "agreement"],
      when: canRun,
      run: () => runRecommended(),
    },
  ];
}

let started = false;

/** Registers the commands once per page (the Results pane's module starts it, as it does the auto-reveal). */
export function startAgreementCommands(): void {
  if (started) return;
  started = true;
  registerCommands(agreementCommands());
}

/** For tests. */
export function resetAgreementCommands() {
  refused.clear();
}
