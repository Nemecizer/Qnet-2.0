// The "Qnet Startup Check" sheet (0.90.34 StartupDependencyCheckView.swift; ledger ANA-238,
// ANA-251…255): the progress box, one row per dependency with its status, the install guidance
// and the copyable commands, and Recheck / Continue. While checks run, Continue is disabled and the
// sheet can't be dismissed. It is a movable panel holding the menus as a sheet did (modality
// "document"), as the app's other sheets are (ledger WS-102).
import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDashed, Info, Loader, OctagonX, TriangleAlert } from "lucide-react";
import { Icon } from "../components/Icon";
import { PanelWindow } from "../lib/panel";
import { PanelForm } from "../canvas/export/PanelForm";
import { analysisWords as w } from "./words";
import {
  attentionCount,
  availableCount,
  brewInstallCommand,
  bundledAttention,
  closeDependencyCheck,
  commandText,
  describe,
  nameOf,
  rerun,
  runIfNeeded,
  supplementalCommands,
  useCheckState,
  type CheckState,
  type DependencyItem,
} from "./deps";
import "./analysis.css";

export const STARTUP_CHECK_PANEL = "startup-check";

/** `headerSubtitle`. */
export function headerSubtitle(st: CheckState): string {
  if (st.currentId) return w.checkingName(nameOf(st.currentId, st));
  if (st.hasRun) return attentionCount(st) === 0 ? w.allReady : w.needAttention(attentionCount(st));
  return w.preparingList;
}

/** `footerSummary`. */
export function footerSummary(st: CheckState): string {
  if (st.running) return w.footerChecking;
  if (attentionCount(st) === 0) return w.footerPassed(availableCount(st), st.items.length);
  return w.footerNotes(availableCount(st), attentionCount(st));
}

/** `installExplanation`. */
function installExplanation(st: CheckState): string {
  if (bundledAttention(st) && !commandText(st)) return w.repairExplanation;
  const brew = brewInstallCommand(st) !== null;
  if (brew && supplementalCommands(st).length) return w.brewAndPython;
  if (brew) return w.brewOnly;
  return w.pythonOnly;
}

function statusText(item: DependencyItem): string {
  const s = item.status;
  switch (s.state) {
    case "pending":
      return w.waiting;
    case "checking":
      return w.checkingNow;
    case "available":
      return s.detail;
    case "missing":
      return w.missing(s.detail);
    case "timedOut":
      return w.timedOut(s.detail);
  }
}

/** The row's tint: green when ready, warning for an optional or timed-out row, danger otherwise. */
function rowTint(item: DependencyItem): "good" | "warn" | "crit" | "muted" {
  const s = item.status.state;
  if (s === "available") return "good";
  if (s === "timedOut" || (s === "missing" && item.requirement.scope === "Optional")) return "warn";
  if (s === "missing") return "crit";
  return "muted";
}

function StatusIcon({ item }: { item: DependencyItem }) {
  const t = rowTint(item);
  switch (item.status.state) {
    case "pending":
      return <Icon icon={CircleDashed} size={16} className="dc-icon" data-tint="muted" />;
    case "checking":
      return <Icon icon={Loader} size={16} className="dc-icon dc-spin" />;
    case "available":
      return <Icon icon={CircleCheck} size={16} className="dc-icon" data-tint="good" />;
    default:
      return <Icon icon={t === "crit" ? OctagonX : TriangleAlert} size={16} className="dc-icon" data-tint={t} />;
  }
}

const SCOPE_TINT = { Runtime: "plain", Developer: "plain", Optional: "warn", Bundled: "info" } as const;

function Row({ item, packaged }: { item: DependencyItem; packaged: boolean }) {
  const { name, summary } = describe(item.requirement, packaged);
  const text = statusText(item);
  return (
    <li className="dc-row" data-checking={item.status.state === "checking" || undefined} aria-label={w.rowLabel(name, item.requirement.scope, text)}>
      <StatusIcon item={item} />
      <div className="dc-row-text">
        <div className="dc-row-head">
          <strong>{name}</strong>
          <span className="an-badge" data-tint={SCOPE_TINT[item.requirement.scope]}>
            {item.requirement.scope}
          </span>
        </div>
        <span className="an-caption">{summary}</span>
        <span className="dc-status" data-tint={rowTint(item)}>
          {text}
        </span>
      </div>
    </li>
  );
}

function Progress({ st }: { st: CheckState }) {
  const last = st.items.find((i) => i.requirement.id === st.lastCheckedId);
  const attention = attentionCount(st);
  return (
    <div className="dc-progress" role="status">
      {st.running ? (
        <Icon icon={Loader} size={16} className="dc-icon dc-spin" />
      ) : st.hasRun ? (
        <Icon icon={attention === 0 ? CircleCheck : TriangleAlert} size={16} className="dc-icon" data-tint={attention === 0 ? "good" : "warn"} />
      ) : (
        <Icon icon={Info} size={16} className="dc-icon" data-tint="info" />
      )}
      <div className="dc-row-text">
        {st.currentId ? (
          <>
            <strong>{w.checkingName(nameOf(st.currentId, st))}</strong>
            {last ? (
              <span className="dc-status" data-tint={last.status.state === "available" ? "good" : "warn"}>
                {w.justChecked(describe(last.requirement, st.packaged).name)}
              </span>
            ) : null}
          </>
        ) : st.hasRun ? (
          <>
            <strong>{attention === 0 ? w.complete : w.completeWithNotes}</strong>
            <span className="an-caption">{w.greenMeans}</span>
          </>
        ) : (
          <strong>{w.preparing}</strong>
        )}
      </div>
    </div>
  );
}

function Guidance({ st }: { st: CheckState }) {
  const text = commandText(st);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No pasteboard in this context: the command stays selectable.
    }
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <section className="dc-guidance" aria-label={bundledAttention(st) && !text ? w.repairTitle : w.installTitle}>
      <strong>{bundledAttention(st) && !text ? w.repairTitle : w.installTitle}</strong>
      <span className="an-caption">{installExplanation(st)}</span>
      {text ? (
        <div className="dc-command">
          <pre className="mono">{text}</pre>
          <button type="button" className="btn" title={w.copyHelp} onClick={() => void copy()}>
            {copied ? w.copied : w.copy}
          </button>
        </div>
      ) : null}
      {supplementalCommands(st).length ? <span className="an-caption">{w.cvxpyNote}</span> : null}
      {bundledAttention(st) ? <span className="dc-status" data-tint="warn">{w.bundledNote}</span> : null}
    </section>
  );
}

export function StartupCheckView() {
  const st = useCheckState();
  useEffect(() => {
    void runIfNeeded();
  }, []);
  const attention = attentionCount(st);
  return (
    <PanelForm
      id={STARTUP_CHECK_PANEL}
      title={w.checkSheetTitle}
      subtitle={headerSubtitle(st)}
      footer={{
        summary: <span className="dc-footer" data-tint={st.running ? "muted" : attention === 0 ? "good" : "warn"}>{footerSummary(st)}</span>,
        cancelTitle: w.recheck,
        confirmTitle: w.continue,
        canConfirm: !st.running,
        cancelHelp: w.recheckHelp,
        confirmHelp: w.continueHelp,
        blockedHelp: w.continueBlocked,
        onCancel: () => {
          if (!st.running) void rerun();
        },
        onConfirm: () => {
          closeDependencyCheck();
        },
      }}
    >
      <Progress st={st} />
      <ul className="dc-rows">
        {st.items.map((i) => (
          <Row key={i.requirement.id} item={i} packaged={st.packaged} />
        ))}
      </ul>
      {st.hasRun && attention > 0 ? <Guidance st={st} /> : null}
    </PanelForm>
  );
}

/** Mounts the checklist while it is up. */
export function StartupCheckHost() {
  const st = useCheckState();
  if (!st.open) return null;
  return (
    <PanelWindow
      id={STARTUP_CHECK_PANEL}
      title={w.checkSheetTitle}
      band="tall"
      modality="document"
      escapeCloses={false}
      closeGuard={() => closeDependencyCheck()}
      onClose={() => closeDependencyCheck()}
    >
      <StartupCheckView />
    </PanelWindow>
  );
}
