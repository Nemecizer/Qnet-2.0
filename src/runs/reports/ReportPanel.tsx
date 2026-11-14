// The Failure Report panel (new in 2.0, ROADMAP A4): what happened in plain words, what to try,
// what was run, the last lines of output, and Reveal in Finder / Copy Report / Try <method>.
// It is modeless, so the Run menu stays live behind it. `FailureReportHost` renders it while a
// report is open; the lead mounts it in App.tsx.
import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { runCommand } from "../../lib/commands";
import { PanelWindow } from "../../lib/panel";
import type { FailureReport } from "../../lib/types";
import { writeClipboard } from "../../panes/status/state";
import { PanelHeader } from "../../windows/parameters/chrome";
import { addStatus, selectTab, tabById } from "../../workspace/store";
import { closeReport, useOpenReport, type OpenReport } from "./state";
import { commandFor, recommendations } from "../../windows/methodchooser/advice";
import { explain, reportText, reportWords as w, tooLarge, type Advised } from "./words";
import "../../panes/inspector/inspector.css";
import "../../workspace/files/files.css";
import "./reports.css";

/** How long the panel waits for a report that is still being written: 40 × 250 ms. Tests shorten it. */
export const reportTiming = { retries: 40, retryMs: 250 };

/** `report_get`'s answer while the report's folder is there and its `report.json` is not yet (`STILL_WRITING` in src-tauri/src/reports.rs). */
const stillWriting = (e: unknown) => {
  const err = e as { kind?: unknown; message?: unknown } | null;
  return err?.kind === "unavailable" && err.message === "Qnet is still writing that failure report.";
};

export function FailureReportHost() {
  const open = useOpenReport();
  if (!open) return null;
  return <FailureReportPanel key={open.id} open={open} />;
}

function FailureReportPanel({ open }: { open: OpenReport }) {
  const [report, setReport] = useState<FailureReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // "Show Report…" is there as soon as the run ends, and the report's files are written just
    // after (src-tauri/src/runs.rs): while the backend says it is still writing, ask again.
    const read = (triesLeft: number) =>
      api.reportGet(open.id).then(
        (r) => live && setReport(r),
        (e) => {
          if (!live) return;
          if (stillWriting(e) && triesLeft > 0) timer = setTimeout(() => void read(triesLeft - 1), reportTiming.retryMs);
          else setProblem(stillWriting(e) ? w.notWritten : String(e) || w.gone);
        },
      );
    void read(reportTiming.retries);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open.id]);

  // A network too large for the method: what does work is the Method Chooser's to say (its rows
  // for the tab's network as it is now), so the explanation can name it. Without an answer the
  // explanation points at the chooser.
  const [advised, setAdvised] = useState<Advised[]>([]);
  useEffect(() => {
    const document = tabById(open.tabId)?.document;
    if (!report || !tooLarge(report) || !document) return;
    let live = true;
    Promise.all([api.methodDomain(document), api.methodAvailability()]).then(
      ([domain, availability]) => {
        if (!live) return;
        const rows = recommendations(domain, availability).filter((r) => r.suitability === "recommended" || r.suitability === "applicable");
        setAdvised(rows.flatMap((r) => {
          const command = commandFor(r.id, domain.infiniteBuffers);
          return command?.startsWith("run:") ? [{ command, name: r.name }] : [];
        }));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [report, open.tabId]);

  const win = () => bodyRef.current?.ownerDocument.defaultView ?? undefined;
  const e = report ? explain(report, advised) : null;

  const reveal = () => void api.reportsReveal(open.id).catch((err) => setProblem(String(err)));
  const copy = async () => {
    if (!report || !e) return;
    await writeClipboard(reportText(report, e), win());
    setCopied(true);
  };
  const tryMethod = async () => {
    if (!e?.tryMethod) return;
    const command = e.tryMethod.command;
    // The run is for the tab that failed: bring it forward, then run the menu's own command
    // (its sheet and its gates apply).
    if (!tabById(open.tabId)) {
      addStatus(w.gone, "warning");
      closeReport();
      return;
    }
    selectTab(open.tabId);
    closeReport();
    await runCommand(command);
  };

  return (
    <PanelWindow id="failure-report" title={w.panelTitle} band="wide" modality="modeless" onClose={closeReport}>
      <div ref={bodyRef} className="qn-sheet report-panel" role="document" aria-label={w.panelTitle}>
        <PanelHeader
          glyph={<Icon icon={TriangleAlert} size={20} className="run-ui-glyph-warning" aria-hidden />}
          title={w.panelTitle}
          subtitle={report ? w.panelSubtitle(report.methodName, report.networkTitle) : ""}
        />
        <div className="report-body">
          {problem ? <p role="alert" className="report-problem">{problem}</p> : null}
          {!report && !problem ? <p className="report-muted">{w.loading}</p> : null}
          {report && e ? (
            <>
              <section aria-label={e.title} data-cause={e.cause}>
                <h2 className="report-title">{e.title}</h2>
                <p className="report-text">{e.body}</p>
                {e.detail && e.cause !== "other" ? (
                  <p className="report-detail">
                    <span className="report-muted">{w.solverSaid}: </span>
                    <code>{e.detail}</code>
                  </p>
                ) : null}
              </section>
              {e.next.length ? (
                <section aria-label={w.whatToTry}>
                  <h3 className="report-heading">{w.whatToTry}</h3>
                  <ul className="report-next">
                    {e.next.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section aria-label={w.whatWasRun}>
                <h3 className="report-heading">{w.whatWasRun}</h3>
                <dl className="report-facts">
                  <dt>{w.method}</dt>
                  <dd>{`${report.methodName}, ${w.buffers(report.infiniteBuffers)}`}</dd>
                  <dt>{w.network}</dt>
                  <dd>{report.networkTitle}</dd>
                  <dt>{w.ended}</dt>
                  <dd>{w.endedHow(report)}</dd>
                  {Object.keys(report.settings).length ? (
                    <>
                      <dt>{w.settings}</dt>
                      <dd>{Object.entries(report.settings).map(([k, v]) => `${k} = ${v}`).join("; ")}</dd>
                    </>
                  ) : null}
                  {report.commands.map((c, i) => (
                    <FactRow key={i} term={w.command} mono>{`${c.command} → ${c.ended}`}</FactRow>
                  ))}
                  {report.runtime ? <FactRow term={w.runtime} mono>{report.runtime}</FactRow> : null}
                  <dt>{w.system}</dt>
                  <dd>{`Qnet ${report.qnetVersion} · macOS ${report.macosVersion} · ${report.chip}`}</dd>
                  <FactRow term={w.folder} mono>{report.folder}</FactRow>
                </dl>
              </section>
              <section aria-label={w.lastOutput}>
                <h3 className="report-heading">{w.lastOutput}</h3>
                {report.stderrTail.trim() ? <pre className="report-output" data-stream="stderr" tabIndex={0} aria-label={w.errorOutput}>{report.stderrTail}</pre> : null}
                {report.outputTail.trim() ? (
                  <pre className="report-output" data-stream="output" tabIndex={0} aria-label={w.lastOutput}>{report.outputTail}</pre>
                ) : report.stderrTail.trim() ? null : (
                  <p className="report-muted">{w.noOutput}</p>
                )}
              </section>
              <p className="report-muted report-privacy">{w.privacy}</p>
            </>
          ) : null}
        </div>
        <footer className="panel-footer">
          <div className="panel-footer-note" />
          <button type="button" className="btn" title={w.revealHelp} disabled={!report} onClick={reveal}>
            {w.reveal}
          </button>
          <button type="button" className="btn" title={w.copyHelp} disabled={!report} onClick={() => void copy()}>
            <span aria-live="polite">{copied ? w.copied : w.copy}</span>
          </button>
          {e?.tryMethod ? (
            <button type="button" className="btn primary" title={w.tryHelp(e.tryMethod.name)} onClick={() => void tryMethod()}>
              {w.tryMethod(e.tryMethod.name)}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={closeReport}>
              {w.close}
            </button>
          )}
        </footer>
      </div>
    </PanelWindow>
  );
}

function FactRow({ term, mono, children }: { term: string; mono?: boolean; children: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={mono ? "report-mono" : undefined}>{children}</dd>
    </>
  );
}
