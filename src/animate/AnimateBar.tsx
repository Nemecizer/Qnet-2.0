// The animation's control bar (new in 2.1, ROADMAP Phase E), floating at the foot of the canvas:
// Play/Pause, Restart (same seed), New Run (new seed), the speed, Skip Ahead, the clock, and a
// strip chart of the number at one station with its running average and — when a closed form
// applies — the exact long-run mean as a dashed line, so the run is seen to fluctuate round it.
//
// It always says what it is: "Animation (one random run)", and that results come from Solve.
import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Shuffle, SkipForward, X } from "lucide-react";
import { Icon } from "../components/Icon";
import { useEditorView } from "../editor";
import type { Editor } from "../editor/editor";
import { displayFixed } from "../editor/numbers";
import { useSetting } from "../lib/kv";
import { SPEEDS } from "./clock";
import type { AnimationEngine } from "./engine";
import { seriesOf, SHAPE_PATHS, shapeOf, type Shape } from "./render";
import { setAnimate } from "./store";
import { StripChart } from "./StripChart";
import { animateWords as w } from "./words";

/** The spoken summary is refreshed this often while playing. */
const SPOKEN_MS = 10_000;

interface Props {
  editor: Editor;
  engine: AnimationEngine;
  reduced: boolean;
  restarted: boolean;
  onRestart: () => void;
  onNewRun: () => void;
}

/** A class's token, as the canvas draws it. */
export function ClassGlyph({ cls }: { cls: number }) {
  const shape: Shape = shapeOf(cls);
  const fill = `var(--series-${seriesOf(cls)})`;
  return (
    <svg className="animate-glyph" width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true" data-shape={shape}>
      <path d={SHAPE_PATHS[shape]} fill={fill} fillRule="evenodd" />
    </svg>
  );
}

export function AnimateBar({ editor, engine, reduced, restarted, onRestart, onNewRun }: Props) {
  const view = useEditorView(editor);
  const decimals = Math.min(Number(useSetting<number>("output.decimals", 6)), 3);
  const fmt = (v: number) => displayFixed(v, decimals);
  const time = (v: number) => displayFixed(v, Math.min(decimals, 1));
  const close = () => setAnimate(editor.tabId, false);
  const [spoken, setSpoken] = useState("");
  const spokenAt = useRef(0);

  const { layout, state, clock } = engine;
  const running = engine.phase === "running" && layout && state;
  const playing = engine.playing;

  // A summary for a screen reader: on pause, and every few seconds while playing.
  useEffect(() => {
    if (!running) return;
    const now = Date.now();
    if (playing && now - spokenAt.current < SPOKEN_MS) return;
    spokenAt.current = now;
    setSpoken(w.spoken(time(clock.time), layout.stations.map((s, i) => w.spokenStation(s.name, state.number(i), state.stations[i].busy, s.servers))));
    // Refreshed with the engine's progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.version, playing]);

  if (engine.phase === "refused" || engine.phase === "failed") {
    return (
      <div className="animate-bar canvas-panel" role="group" aria-label={w.barLabel} data-animate-bar={engine.phase}>
        <div className="animate-refused" role="status">
          <strong>{engine.phase === "refused" ? w.refusedTitle : w.failedTitle}</strong>
          <span>{engine.message}</span>
        </div>
        <button type="button" className="btn animate-close" onClick={close} title={w.closeHelp}>
          {w.close}
        </button>
      </div>
    );
  }

  if (!running) {
    return (
      <div className="animate-bar canvas-panel" role="group" aria-label={w.barLabel} data-animate-bar="starting">
        <span className="animate-title">{w.title}</span>
        <span className="animate-quiet" role="status">
          {w.starting}
        </span>
        <button type="button" className="btn animate-icon" onClick={close} title={w.closeHelp} aria-label={w.close}>
          <Icon icon={X} size={12} />
        </button>
      </div>
    );
  }

  // The station charted: the one selected (or the one its selected buffer feeds), else the first.
  const selected = view.selectedNodeID;
  const pick = layout.stations.findIndex((s) => s.id === selected || s.bufferId === selected);
  const at = pick >= 0 ? pick : 0;
  const station = layout.stations[at];
  const now = clock.time;
  const n = state.number(at);
  const average = state.average(at, now);
  const exact = station.exactNumber;
  const span = now - state.origin;
  const closed = layout.population !== null;

  return (
    <div className="animate-bar canvas-panel" role="group" aria-label={w.barLabel} data-animate-bar="running" data-playing={playing || undefined}>
      <div className="animate-row">
        <span className="animate-title" title={w.useSolve}>
          {w.title}
        </span>
        <button type="button" className="btn primary animate-play" onClick={() => engine.toggle()} title={w.playHelp} aria-label={playing ? w.pause : w.play} aria-keyshortcuts="Space">
          <Icon icon={playing ? Pause : Play} size={12} aria-hidden="true" />
          <span>{playing ? w.pause : w.play}</span>
        </button>
        <button type="button" className="btn" onClick={onRestart} title={w.restartHelp}>
          <Icon icon={RotateCcw} size={12} aria-hidden="true" />
          <span>{w.restart}</span>
        </button>
        <button type="button" className="btn" onClick={onNewRun} title={w.newRunHelp}>
          <Icon icon={Shuffle} size={12} aria-hidden="true" />
          <span>{w.newRun}</span>
        </button>
        <label className="animate-speed" title={w.speedHelp(fmt(clock.pace))}>
          <span>{w.speed}</span>
          <select value={clock.speed} onChange={(ev) => engine.setSpeed(Number(ev.target.value))} aria-label={w.speed}>
            {SPEEDS.map((x) => (
              <option key={x} value={x}>
                {w.speedOption(x)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => void engine.skip()} disabled={engine.skipping} title={w.skipHelp(time(engine.skipSpan()))}>
          <Icon icon={SkipForward} size={12} aria-hidden="true" />
          <span>{engine.skipping ? w.skipping : w.skip}</span>
        </button>
        <span className="animate-clock" title={w.clockSpoken(time(now))} data-animate-clock>
          <span className="animate-num">{w.clock(time(now))}</span>
          <span className="animate-quiet">{w.clockUnit}</span>
        </span>
        <span className="animate-quiet animate-seed" title={w.seedHelp}>
          {w.seed(engine.seed)}
        </span>
        <button type="button" className="btn animate-icon" onClick={close} title={w.closeHelp} aria-label={w.close}>
          <Icon icon={X} size={12} />
        </button>
      </div>

      <div className="animate-row animate-chart-row">
        <StripChart history={state.stations[at].history} now={now} window={state.window} exact={exact} label={w.chartSpoken(station.name, n, average === null ? null : fmt(average), time(span), exact === null ? null : fmt(exact))} />
        <div className="animate-readout">
          <span className="animate-strong">{w.chartTitle(station.name)}</span>
          <span>
            <span className="animate-num">{w.chartNow(n)}</span>
            {" · "}
            <span className="animate-num" data-animate-average>
              {average === null ? w.chartNoAverage : w.chartAverage(fmt(average), time(span))}
            </span>
          </span>
          <span className={exact === null ? "animate-quiet" : "animate-exact"} data-animate-exact={exact === null ? undefined : fmt(exact)}>
            {exact !== null ? w.chartExact(fmt(exact)) : layout.unstable.length ? w.chartUnstableExact : w.chartNoExact}
          </span>
          <span className="animate-quiet">
            {closed ? w.population(layout.population!) : w.inNetwork(state.total())}
            {" · "}
            {w.chartWindow(time(state.window))}
            {layout.stations.length > 1 && pick < 0 ? ` · ${w.chartPick}` : ""}
          </span>
        </div>
        {layout.classes > 1 && (
          <ul className="animate-legend" aria-label={w.legendLabel}>
            {Array.from({ length: layout.classes }, (_, c) => (
              <li key={c}>
                <ClassGlyph cls={c} />
                <span>{w.classLegend(c)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {layout.unstable.length > 0 && (
        <p className="animate-banner" role="status" data-animate-banner="unstable">
          {w.unstable(layout.unstable)}
        </p>
      )}
      {restarted && (
        <p className="animate-note" role="status" data-animate-note="restarted">
          {w.restarted}
        </p>
      )}
      {reduced && (
        <p className="animate-note" data-animate-note="reduced">
          {w.reduced}
        </p>
      )}
      <p className="animate-note animate-caveat">
        {closed ? w.biasClosed : w.biasOpen} {w.useSolve}
      </p>
      <span className="sr-only" aria-live="polite" data-animate-spoken>
        {spoken}
      </span>
    </div>
  );
}
