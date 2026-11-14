// Run ▸ Choose a Method… (0.90.34 MethodChooserView.swift `MethodChooserWindow`, `MethodChooserModel`,
// `MethodChooserView`, `MethodAdviceRow`; ledger ANA-192…201, SET-201).
//
// One window, "method-chooser", built once and re-pointed: asking again brings the open window
// forward and points it at the tab that is active now, so the frame the user dragged it to stays.
// It follows that tab's document as it is edited (0.90.34 observed the editor); when the tab is
// closed it shows "No Active Network". Each open asks the resolver again which solvers are
// installed (INV-033: that is a separate question from the network's domain, and is asked
// separately). Run Method closes the window and then runs the Run menu's own command for the row
// (`runCommand("run:…")`), so the parameter sheets and gates are the Run menu's.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Network as NetworkIcon, Search } from "lucide-react";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { getCommand, runCommand } from "../../lib/commands";
import { openHelp } from "../help/state";
import { raiseAuxWindow } from "../../lib/auxWindow";
import type { MethodDomain, RuntimeAvailability } from "../../lib/types";
import { editorFeedback } from "../../editor";
import { analysisKey } from "../../panes/status/analysis";
import { statusWords } from "../../panes/status/words";
import { activeTab, getWorkspace, useWorkspace } from "../../workspace/store";
import { AnalysisWindow, Badge, EmptyState, type Tint } from "../../analysis/AnalysisWindow";
import { commandFor, filterAdvice, recommendations, type Layer, type MethodAdvice, type Suitability } from "./advice";
import { methodChooserWords as w } from "./words";

export const METHOD_CHOOSER_WINDOW = "method-chooser";
export const METHOD_CHOOSER_FRAME_KEY = "WindowFrame.QnetMethodChooserWindow";

// ── Which tab the window points at ──────────────────────────────────────────────────────────

let model: { tabId: string; opened: number } | null = null;
let opened = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

/** Run ▸ Choose a Method…: opens the chooser for the active tab, or re-points the open one and brings it forward. */
export function openMethodChooser(tabId: string = activeTab(getWorkspace()).id) {
  const wasOpen = model !== null;
  model = { tabId, opened: ++opened };
  publish();
  if (wasOpen) raiseAuxWindow(METHOD_CHOOSER_WINDOW);
}

export function closeMethodChooser() {
  model = null;
  publish();
}

export function methodChooserState() {
  return model;
}

function useModel() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => model,
  );
}

// ── The view ────────────────────────────────────────────────────────────────────────────────

const LAYER_TINT: Record<Layer, Tint> = { exactQueue: "good", queueApproximation: "warn", queueSimulation: "info", srbmAnalytical: "accent", srbmNumerical: "accent" };
const SUITABILITY_TINT: Record<Suitability, Tint> = { recommended: "good", applicable: "info", caution: "warn", experimental: "warn", unavailable: "muted" };

/** Opens the Help window at the row's topic: always the window, whatever Settings ▸ Help says (HELP-093, HELP-098). */
function openReference(topic: string) {
  openHelp(topic);
}

/** Run Method: the window closes, then the row's Run-menu command runs (an unknown id beeps). */
export function runAdvised(id: string, infiniteBuffers: boolean) {
  closeMethodChooser();
  const command = commandFor(id, infiniteBuffers);
  setTimeout(() => {
    if (!command || !getCommand(command)) {
      editorFeedback.beep();
      return;
    }
    void runCommand(command);
  }, 0);
}

function AdviceRow({ advice, onRun }: { advice: MethodAdvice; onRun: () => void }) {
  return (
    <article className="mc-row" aria-label={advice.name}>
      <div className="mc-row-head">
        <div className="mc-row-names">
          <h3>{advice.name}</h3>
          <span className="an-caption">{advice.implementation}</span>
        </div>
        <Badge text={w.layers[advice.layer]} tint={LAYER_TINT[advice.layer]} />
        <Badge text={w.suitability[advice.suitability]} tint={SUITABILITY_TINT[advice.suitability]} />
      </div>
      <p className="mc-summary">{advice.summary}</p>
      <dl className="mc-grid">
        <dt>{w.assumptions}</dt>
        <dd>{advice.assumptions}</dd>
        <dt>{w.cost}</dt>
        <dd>{advice.cost}</dd>
        <dt>{w.outputs}</dt>
        <dd>{advice.outputs}</dd>
      </dl>
      <div className="mc-row-actions">
        {advice.suitability !== "unavailable" ? (
          <button type="button" className="btn primary" onClick={onRun}>
            {w.runMethod}
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" className="an-link" onClick={() => openReference(advice.helpTopic)}>
          {w.openReference}
        </button>
      </div>
    </article>
  );
}

export function MethodChooserView({ tabId, opened: openedAt, onClose }: { tabId: string; opened: number; onClose: () => void }) {
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId));
  const key = tab ? analysisKey(tab.document) : null;
  const [domain, setDomain] = useState<MethodDomain | null>(null);
  const [availability, setAvailability] = useState<RuntimeAvailability[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!tab) return;
    let alive = true;
    api.methodDomain(tab.document).then(
      (d) => alive && setDomain(d),
      () => alive && setDomain(null),
    );
    return () => {
      alive = false;
    };
    // The document as the analysis reads it: a move or a zoom asks nothing again.
  }, [tabId, key]);

  useEffect(() => {
    let alive = true;
    setAvailability(null);
    api.methodAvailability().then(
      (a) => alive && setAvailability(a),
      () => alive && setAvailability([]),
    );
    return () => {
      alive = false;
    };
  }, [tabId, openedAt]);

  if (!tab) {
    return (
      <div className="an-fill">
        <EmptyState icon={<Icon icon={NetworkIcon} size={20} />} title={w.noNetworkTitle} message={w.noNetworkMessage} />
      </div>
    );
  }
  const rows = domain && availability ? filterAdvice(recommendations(domain, availability), search) : null;
  const stations = tab.document.nodes.filter((n) => n.kind === "station").length;
  return (
    <div className="an-fill" aria-label={w.windowTitle}>
      <header className="an-header">
        <Icon icon={NetworkIcon} size={20} className="an-glyph" />
        <div className="an-heading">
          <h2>{w.title}</h2>
          <span className="an-caption">{w.subtitle}</span>
        </div>
        <span className="spacer" />
        <label className="an-search" title={w.filterHelp}>
          <Icon icon={Search} size={12} />
          <input type="search" placeholder={w.filterPlaceholder} aria-label={w.filterPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </header>
      <div className="an-summary">
        <Badge text={tab.document.infiniteBuffers ? w.infiniteBuffers : w.finiteBuffers} />
        <Badge text={w.stations(stations)} />
        {domain?.hasFeedback ? <Badge text={w.feedback} tint="warn" /> : null}
        {domain && domain.warningCount > 0 ? <Badge text={w.warnings(domain.warningCount)} tint="warn" /> : null}
      </div>
      <div className="mc-list" role="list">
        {rows === null ? <p className="an-caption mc-checking">{w.checking}</p> : null}
        {rows?.map((r) => (
          <div role="listitem" key={r.id}>
            <AdviceRow advice={r} onRun={() => runAdvised(r.id, tab.document.infiniteBuffers)} />
          </div>
        ))}
        {rows !== null && rows.length === 0 ? <EmptyState title={statusWords.noResults(search)} message={statusWords.noResultsMessage} /> : null}
      </div>
      <footer className="an-footer">
        <span className="an-caption">{w.footer}</span>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={onClose}>
          {w.close}
        </button>
      </footer>
    </div>
  );
}

/** Mounts the chooser's window while it is open. */
export function MethodChooserHost() {
  const m = useModel();
  if (!m) return null;
  return (
    <AnalysisWindow name={METHOD_CHOOSER_WINDOW} title={w.windowTitle} frameKey={METHOD_CHOOSER_FRAME_KEY} onClose={closeMethodChooser} onDefault={closeMethodChooser}>
      <MethodChooserView tabId={m.tabId} opened={m.opened} onClose={closeMethodChooser} />
    </AnalysisWindow>
  );
}

/** For tests. */
export function resetMethodChooser() {
  model = null;
  publish();
}
