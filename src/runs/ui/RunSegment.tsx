// The status bar's run segment (0.90.34 ContentView.swift `runSegment`; ledger CAN-163, RUN-046,
// RUN-051): while a run is live, a determinate bar with "47% · m:ss" when the solver reports
// progress, else a spinner with "Running <run> for <tab>… m:ss", and a Stop button that is live
// from the click that started the run; afterwards "<last outcome> · <tab>" with a success, warning
// or failure icon; before any run, "Idle".
//
// Mounted in the canvas status bar's run slot: `<CanvasStatusBar editor={…} run={<RunSegment />} />`.
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { Icon, StopIcon } from "../../components/Icon";
import { announce } from "../../lib/announce";
import { shortcutFor } from "../../lib/menu";
import { stopRun } from "../state";
import { useLiveRuns } from "./live";
import { clock, displayLabel, runWords as w } from "./words";
import "./runs-ui.css";

/** Seconds since `since`, ticking while `live`. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, (now - since) / 1000);
}

export function RunSegment() {
  const { live, last } = useLiveRuns();
  const elapsed = useElapsed(live ? live.startedAt : null);
  const stopKey = shortcutFor("run:stop") ?? "⌘.";

  // A screen reader hears a run start and how it ended, once each (the segment itself is not a
  // live region: its clock changes four times a second). Nothing is said for what was already
  // there when the bar appeared.
  const spoken = live ? w.announceStarted(displayLabel(live.method), live.tabTitle || w.anotherTab) : last ? w.announceEnded(last.statusBar, last.tabTitle) : "";
  const said = useRef<string | null>(null);
  useEffect(() => {
    const first = said.current === null;
    if (said.current === spoken) return;
    said.current = spoken;
    if (!first && spoken) announce(spoken, !live && last?.kind === "failure" ? "assertive" : "polite");
  }, [spoken, live, last]);

  if (live) {
    const run = displayLabel(live.method);
    const tab = live.tabTitle || w.anotherTab;
    const time = clock(elapsed);
    const pct = live.fraction === null ? null : Math.round(live.fraction * 100);
    const help = pct === null ? w.segmentHelpRunning(run, tab, time, stopKey) : w.segmentHelpProgress(run, tab, pct, time, stopKey);
    const a11y = pct === null ? w.segmentA11yRunning(run, tab, time) : w.segmentA11yProgress(run, tab, pct, time);
    return (
      <span className="run-seg" title={help} role="group" aria-label={a11y} data-state="running">
        {pct === null ? (
          <>
            <Icon icon={LoaderCircle} size={12} className="run-seg-spin" />
            <span className="run-seg-text">{w.segmentRunning(run, tab, time)}</span>
          </>
        ) : (
          <>
            <progress className="run-seg-bar" max={1} value={live.fraction ?? 0} aria-label={w.progressLabel} />
            <span className="run-seg-readout">{w.segmentProgress(pct, time)}</span>
          </>
        )}
        <button type="button" className="icon-btn run-seg-stop" aria-label={w.stopButton} title={w.stopButtonHelp(run, stopKey)} onClick={() => void stopRun()}>
          <Icon icon={StopIcon} size={14} />
        </button>
      </span>
    );
  }
  if (last) {
    const glyph = last.kind === "success" ? CircleCheck : last.kind === "warning" ? CircleAlert : CircleX;
    return (
      <span className="run-seg" title={w.lastRunHelp(last.statusBar)} aria-label={w.lastRunHelp(last.statusBar)} role="group" data-state={last.kind}>
        <Icon icon={glyph} size={12} className={`run-seg-${last.kind}`} />
        <span className="run-seg-text">{w.lastRun(last.statusBar, last.tabTitle)}</span>
      </span>
    );
  }
  return (
    <span className="run-seg" title={w.idleHelp} data-state="idle">
      <span>{w.idle}</span>
    </span>
  );
}
