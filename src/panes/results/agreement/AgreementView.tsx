// The Agreement view (new in 2.1, ROADMAP B3): for the active tab's network as it is now, what the
// methods that have run say when read together — a verdict in plain words with the evidence behind
// it, then one row per quantity with the reference value and every other method as a mark on a
// shared deviation axis (−10 % … +10 %). The numbers and verdicts are `agreement()`'s
// (src/results/insight.ts); the words about a method are the Method Chooser's. The axis is plain
// SVG coloured by the tier tokens, so it prints and exports as it shows.
//
// Docked or detached, it reaches its document only through its own elements.
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDot, Hash, Info, Network as NetworkIcon, Play, ShieldCheck, Square, TriangleAlert, X } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { displayFixed } from "../../../editor/numbers";
import { getCommand, runCommand } from "../../../lib/commands";
import { shortcutFor } from "../../../lib/menu";
import { agreement, bestRun, CLOSE, currentRuns, stationValues, type MethodValue, type Tier } from "../../../results/insight";
import { useLiveRuns } from "../../../runs/ui/live";
import type { Tab } from "../../../workspace/store";
import type { ResultRecord } from "../model";
import { useAdvice, type Advice } from "./chooser";
import { ExplainButton } from "../../ai/explain/open";
import { checkHelp, checkPreview, checkWithAnother, rerunStale, runRecommended, solve, solveHelp, solvePreview } from "./commands";
import { disagreementReasons, ofNetwork, rowFor as chooserRow } from "./plan";
import { AXIS_LEFT, AXIS_RIGHT, axisPosition, bannerFor, deviationText, groupByStation, markNotes, rowsFor, type Banner, type BannerKind, type Mark, type Row, type RowSort } from "./rows";
import { dismissSequence, stopSequence, useSequence, type Sequence } from "./runner";
import { agreementWords as w } from "./words";
import "./agreement.css";

const BANNER_ICON: Record<BannerKind, LucideIcon> = { exact: ShieldCheck, agree: CircleCheck, close: CircleDot, disagree: TriangleAlert, single: Info, incomparable: Info };

const ROW_H = 30;
const MID = ROW_H / 2;
const LANE = 6;

/** A tier's mark, centred on the origin: the shape says the tier as well as the colour. */
export function TierShape({ tier, r = 4.5 }: { tier: Tier; r?: number }) {
  switch (tier) {
    case "exact": return <path d={`M0 ${-r - 1} L${r + 1} 0 L0 ${r + 1} L${-r - 1} 0 Z`} />;
    case "simulation": return <circle r={r} />;
    case "approximation": return <path d={`M0 ${-r - 0.5} L${r + 0.5} ${r - 0.5} L${-r - 0.5} ${r - 0.5} Z`} />;
    case "diffusion": return <rect x={-r + 0.5} y={-r + 0.5} width={2 * r - 1} height={2 * r - 1} />;
    case "bound": return <rect x={-r - 1} y={-1.75} width={2 * r + 2} height={3.5} />;
    default: return <path d={`M${-r} ${-r} L${r} ${r} M${-r} ${r} L${r} ${-r}`} fill="none" strokeWidth={2} />;
  }
}

function TierGlyph({ tier }: { tier: Tier }) {
  return (
    <svg className="agr-glyph" data-tier={tier} width={14} height={14} viewBox="-7 -7 14 14" aria-hidden>
      <TierShape tier={tier} />
    </svg>
  );
}

function EmptyState({ icon, title, message, children }: { icon: LucideIcon; title: string; message: string; children?: ReactNode }) {
  return (
    <div className="empty-state agr-empty">
      <Icon icon={icon} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{message}</p>
      {children ? <div className="agr-actions">{children}</div> : null}
    </div>
  );
}

/** The sequential runner's line: what is running with Stop, then how it went. */
function Progress({ seq }: { seq: Sequence }) {
  if (!seq.finished) {
    const step = seq.steps[Math.min(seq.index, seq.steps.length - 1)];
    return (
      <div className="agr-progress" role="status" aria-label={w.progressLabel}>
        <span className="agr-spinner" aria-hidden />
        <span className="agr-progress-text">{w.progress(seq.index + 1, seq.steps.length, step.name)}</span>
        <span className="spacer" />
        <button type="button" className="btn" title={w.stopHelp} disabled={seq.stopping} onClick={() => void stopSequence()}>
          <Icon icon={Square} size={12} aria-hidden /> {w.stop}
        </button>
      </div>
    );
  }
  const done = seq.steps.filter((s) => s.state === "done").length;
  // A sequence cut short by its tab says so once, rather than "was not run" for every method left.
  const cut = seq.ended === "tab-closed" ? w.endedTabClosed : seq.ended === "tab-not-front" ? w.endedTabNotFront : null;
  const notes = seq.steps.filter((s) => s.state !== "done" && !(cut && s.state === "skipped")).map((s) => w.stepNote(s.name, s.state, s.reason));
  if (cut) notes.push(cut);
  // A single method that ran needs no line of its own: its result is the news.
  if (!notes.length && seq.steps.length === 1) return null;
  return (
    <div className="agr-progress" role="status" aria-label={w.progressLabel} data-finished>
      <span className="agr-progress-text">
        {seq.stopping ? w.finishedStopped(done, seq.steps.length) : w.finished(done, seq.steps.length)}
        {notes.length ? ` ${notes.join(" ")}` : ""}
      </span>
      <span className="spacer" />
      <button type="button" className="icon-btn" aria-label={w.dismiss} title={w.dismiss} onClick={dismissSequence}>
        <Icon icon={X} size={12} aria-hidden />
      </button>
    </div>
  );
}

interface Hot {
  row: string;
  runId: string;
}

export function AgreementView({ tab, records, fingerprint, decimals }: { tab: Tab; records: ResultRecord[]; fingerprint: string | null; decimals: number }) {
  const advice = useAdvice(tab);
  const seq = useSequence();
  const live = useLiveRuns().live;
  const bannerId = useId();
  const [sort, setSort] = useState<RowSort>("station");
  const [station, setStation] = useState<string | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const [uncompared, setUncompared] = useState(false);
  const [openMethod, setOpenMethod] = useState<string | null>(null);
  const [hotMethod, setHotMethod] = useState<string | null>(null);
  const [hot, setHot] = useState<Hot | null>(null);

  const runs = useMemo(() => currentRuns(records, fingerprint), [records, fingerprint]);
  const a = useMemo(() => agreement(runs), [runs]);
  const banner = useMemo(() => bannerFor(a, decimals), [a, decimals]);
  const stations = useMemo(() => [...new Set(a.quantities.map((q) => q.stationName))], [a]);
  const metrics = useMemo(() => [...new Set(a.quantities.map((q) => q.metric))].sort(), [a]);
  // A filter that no longer names anything (another tab, a new run) falls back to everything.
  const stationNow = station !== null && stations.includes(station) ? station : null;
  const metricNow = metric !== null && metrics.includes(metric) ? metric : null;
  const rows = useMemo(() => rowsFor(a, { station: stationNow, metric: metricNow, uncompared, sort }), [a, stationNow, metricNow, uncompared, sort]);
  const utilization = useMemo(() => {
    const best = bestRun(runs);
    return new Map((best ? stationValues(best, "Utilization") : []).map((s) => [s.stationID.toUpperCase(), s.value]));
  }, [runs]);

  const fmt = (x: number) => displayFixed(x, decimals);
  const withUnit = (x: number, unit: string) => `${fmt(x)}${unit ? ` ${unit}` : ""}`;
  const busy = (seq !== null && !seq.finished) || live !== null;
  const solvePick = solvePreview(tab);
  const checkPick = checkPreview(tab, records, fingerprint);
  // `advice` is read so the previews above are asked again when the Chooser answers.
  void advice;

  const reasonsFor = (q: Row["q"], v: MethodValue, adv: Advice): string[] => {
    const rho = q.stationID ? (utilization.get(q.stationID.toUpperCase()) ?? null) : null;
    return disagreementReasons(q, v, chooserRow(v.method, adv.rows, adv.infinite), adv.domain, rho, (x) => displayFixed(x, Math.min(decimals, 2)));
  };
  /** Every reason the Chooser's rules give for `method` over the quantities it is far out on. */
  const methodReasons = (method: string): string[] => {
    if (!advice) return [];
    const out = new Set<string>();
    for (const q of a.quantities) {
      const v = q.values.find((x) => x.method === method);
      if (!v || v.isReference || v.withinInterval || v.deviation === null || Math.abs(v.deviation) <= CLOSE) continue;
      reasonsFor(q, v, advice).forEach((r) => out.add(r));
    }
    return [...out];
  };

  const solveButton = (
    <button type="button" className="btn primary" disabled={busy} title={solveHelp(solvePick)} onClick={() => void solve(tab.id)}>
      <Icon icon={Play} size={12} aria-hidden /> {solvePick ? w.solveWith(solvePick.candidate.advice.name) : w.solve}
    </button>
  );
  const recommendedButton = (
    <button type="button" className="btn" disabled={busy} title={w.recommendedHelp} onClick={() => void runRecommended(tab.id)}>
      {w.recommended}
    </button>
  );
  const checkButton = checkPick ? (
    // With an exact result the banner says nothing more is needed, so the offer is not the main action.
    <button type="button" className={banner?.kind === "exact" ? "btn" : "btn primary"} disabled={busy} title={checkHelp(checkPick)} onClick={() => void checkWithAnother(tab.id)}>
      {w.checkWith(checkPick.candidate.advice.name)}
    </button>
  ) : null;
  const chooserButton = getCommand("run:choose-method") ? (
    <button type="button" className="agr-link" title={w.chooserHelp} onClick={() => void runCommand("run:choose-method")}>
      {w.chooserLink}
    </button>
  ) : null;

  const progress = seq && seq.tabId === tab.id ? <Progress seq={seq} /> : null;

  let body: ReactNode;
  if (!tab.document.nodes.length) {
    body = <EmptyState icon={NetworkIcon} title={w.noNetworkTitle} message={w.noNetworkMessage} />;
  } else if (!runs.length) {
    const earlier = currentRuns(records, null).length;
    body = earlier ? (
      <EmptyState icon={TriangleAlert} title={w.staleTitle} message={w.staleMessage(earlier)}>
        <button type="button" className="btn primary" disabled={busy} title={w.rerunHelp} onClick={() => void rerunStale(tab.id)}>
          {w.rerun}
        </button>
      </EmptyState>
    ) : records.some((r) => ofNetwork(r, fingerprint)) && !busy ? (
      <EmptyState icon={Hash} title={w.notComparableTitle} message={w.notComparableMessage}>
        {checkButton ?? solveButton}
        {recommendedButton}
      </EmptyState>
    ) : (
      <EmptyState icon={Hash} title={w.emptyTitle} message={w.emptyMessage(shortcutFor("run:solve"))}>
        {solveButton}
        {recommendedButton}
        {chooserButton}
      </EmptyState>
    );
  } else if (banner) {
    const bannerReasons = banner.worst && advice ? reasonsFor(banner.worst.q, banner.worst.value, advice) : [];
    const grouped = sort === "station";
    const groups = grouped ? groupByStation(rows) : [{ station: "", rows }];
    const open = openMethod ? a.methods.find((m) => m.method === openMethod) : undefined;
    const openRow = open && advice ? chooserRow(open.method, advice.rows, advice.infinite) : null;
    const compared = a.compared;
    // A run that ended early is listed, and says so wherever it shows.
    const partialRuns = new Set(runs.filter((r) => r.status === "partial").map((r) => r.id));
    body = (
      <div className="agr-scroll">
        <BannerView banner={banner} id={bannerId} reasons={bannerReasons}>
          {checkButton}
          {banner.kind === "single" || banner.kind === "incomparable" ? recommendedButton : null}
          {chooserButton}
          <ExplainButton about="agreement" />
        </BannerView>

        <div className="agr-methods" role="group" aria-label={w.methodsLabel}>
          {a.methods.map((m) => (
            <button
              key={m.runId}
              type="button"
              className="agr-method"
              aria-expanded={openMethod === m.method}
              title={w.methodHelp(m.shortName)}
              data-partial={partialRuns.has(m.runId) || undefined}
              onClick={() => setOpenMethod(openMethod === m.method ? null : m.method)}
              onMouseEnter={() => setHotMethod(m.method)}
              onMouseLeave={() => setHotMethod(null)}
              onFocus={() => setHotMethod(m.method)}
              onBlur={() => setHotMethod(null)}
            >
              <TierGlyph tier={m.tier} />
              <span className="agr-method-name">{m.shortName}</span>
              <span className="agr-method-tier">{w.tierShort[m.tier]}</span>
              {partialRuns.has(m.runId) ? (
                <span className="agr-tag" title={w.partialHelp}>
                  {w.partial}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {open ? (
          <section className="agr-explain" aria-label={w.methodHelp(open.shortName)}>
            <div className="agr-explain-head">
              <TierGlyph tier={open.tier} />
              <strong>{openRow?.name ?? open.shortName}</strong>
              <span className="agr-muted">{w.tiers[open.tier]}</span>
              {partialRuns.has(open.runId) ? <span className="agr-tag" title={w.partialHelp}>{w.partial}</span> : null}
            </div>
            {openRow ? (
              <dl>
                {openRow.suitability !== "unavailable" ? (
                  <>
                    <dt>{w.whatItIs}</dt>
                    <dd>{openRow.summary}</dd>
                  </>
                ) : null}
                <dt>{w.trustWhen}</dt>
                <dd>{openRow.assumptions}</dd>
                {(() => {
                  const reasons = openRow.suitability === "unavailable" ? [w.ruledOut(openRow.summary)] : methodReasons(open.method).filter((r) => r !== openRow.summary);
                  return reasons.length ? (
                    <>
                      <dt>{w.mayDiffer}</dt>
                      <dd>{reasons.join(" ")}</dd>
                    </>
                  ) : null;
                })()}
              </dl>
            ) : (
              <p className="agr-muted">{w.notInChooser}</p>
            )}
          </section>
        ) : null}

        <div className="agr-controls">
          <select className="results-picker" aria-label={w.sortLabel} value={sort} onChange={(e) => setSort(e.target.value as RowSort)}>
            <option value="station">{w.sorts.station}</option>
            <option value="disagreement">{w.sorts.disagreement}</option>
          </select>
          <select className="results-picker" aria-label={w.stationFilter} value={stationNow ?? ""} onChange={(e) => setStation(e.target.value || null)}>
            <option value="">{w.allStations}</option>
            {stations.map((s) => (
              <option key={s} value={s}>
                {s || w.network}
              </option>
            ))}
          </select>
          <select className="results-picker" aria-label={w.metricFilter} value={metricNow ?? ""} onChange={(e) => setMetric(e.target.value || null)}>
            <option value="">{w.allMetrics}</option>
            {metrics.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {compared > 0 && compared < a.quantities.length ? (
            <label className="agr-check">
              <input type="checkbox" checked={uncompared} onChange={(e) => setUncompared(e.target.checked)} /> {w.showUncompared}
            </label>
          ) : null}
        </div>

        {rows.length ? (
          <table className="agr-table" aria-label={w.tableLabel} aria-describedby={bannerId}>
            <caption className="sr-only">{w.caption(a.methods.length, a.quantities.length, compared)}</caption>
            <thead>
              <tr>
                <th scope="col">{w.columns.quantity}</th>
                <th scope="col">{w.columns.reference}</th>
                <th scope="col" className="agr-axis-cell">
                  <span className="sr-only">{w.columns.deviation}</span>
                  <svg className="agr-axis agr-axis-head" width="100%" height={16} aria-hidden>
                    <text x={`${AXIS_LEFT}%`} y={12} textAnchor="middle">{w.axisLow}</text>
                    <text x="50%" y={12} textAnchor="middle">{w.axisMid}</text>
                    <text x={`${AXIS_RIGHT}%`} y={12} textAnchor="middle">{w.axisHigh}</text>
                  </svg>
                </th>
                <th scope="col">{w.columns.gap}</th>
                <th scope="col">{w.columns.verdict}</th>
              </tr>
            </thead>
            {groups.map((g, gi) => (
              <tbody key={`${g.station}|${gi}`}>
                {grouped ? (
                  <tr className="agr-group">
                    <th scope="rowgroup" colSpan={5}>
                      {g.station || w.network}
                    </th>
                  </tr>
                ) : null}
                {g.rows.map((row) => (
                  <QuantityRow key={row.q.key} row={row} showStation={!grouped} hot={hot} hotMethod={hotMethod} onHot={setHot} fmt={fmt} withUnit={withUnit} />
                ))}
              </tbody>
            ))}
          </table>
        ) : (
          <p className="agr-muted agr-norows">{w.noRows}</p>
        )}
      </div>
    );
  } else {
    body = <EmptyState icon={Hash} title={w.notComparableTitle} message={w.notComparableMessage} />;
  }

  return (
    <div className="agr-view" data-view="agreement" aria-label={w.title}>
      {progress}
      {body}
    </div>
  );
}

function BannerView({ banner, id, reasons, children }: { banner: Banner; id: string; reasons: string[]; children?: ReactNode }) {
  return (
    <section className="agr-banner" data-verdict={banner.kind} aria-label={w.bannerLabel}>
      <span className="agr-banner-icon">
        <Icon icon={BANNER_ICON[banner.kind]} size={20} aria-hidden />
      </span>
      <div className="agr-banner-text" id={id}>
        <h3>{banner.title}</h3>
        {banner.detail.map((d) => (
          <p key={d}>{d}</p>
        ))}
        {reasons.length ? (
          <p className="agr-reason">
            <strong>{w.likelyReason}</strong> {reasons.join(" ")}
          </p>
        ) : null}
      </div>
      <div className="agr-actions">{children}</div>
    </section>
  );
}

const VERDICT_ICON = { exact: ShieldCheck, agree: CircleCheck, close: CircleDot, disagree: TriangleAlert, single: Info } as const;

function QuantityRow(props: { row: Row; showStation: boolean; hot: Hot | null; hotMethod: string | null; onHot: (h: Hot | null) => void; fmt: (x: number) => string; withUnit: (x: number, unit: string) => string }) {
  const { row, showStation, hot, hotMethod, onHot, fmt, withUnit } = props;
  const { q } = row;
  const where = w.where(q.stationName || w.network, q.classLabel, q.metric);
  const from = q.reference ? `${q.reference.shortName} (${w.tierShort[q.reference.tier]})` : w.meanOfMethods;
  const hotMark = hot && hot.row === q.key ? row.marks.find((m) => m.value.runId === hot.runId) : undefined;
  const lone = row.lone;
  // The one method behind a row with no mark to draw.
  const only = q.reference ?? lone;

  /** ←/→ move between this row's marks, ↑/↓ to the same place in the row above or below. */
  const onKeyDown = (e: KeyboardEvent<SVGGElement>, i: number) => {
    const here = e.currentTarget;
    const mine = [...(here.closest("svg.agr-axis")?.querySelectorAll<SVGGElement>("[data-mark]") ?? [])];
    let next: SVGGElement | undefined;
    if (e.key === "ArrowRight") next = mine[Math.min(mine.length - 1, i + 1)];
    else if (e.key === "ArrowLeft") next = mine[Math.max(0, i - 1)];
    else if (e.key === "Home") next = mine[0];
    else if (e.key === "End") next = mine[mine.length - 1];
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const axes = [...(here.closest("table")?.querySelectorAll<SVGSVGElement>("svg.agr-axis[data-row]") ?? [])];
      const at = axes.findIndex((s) => s.contains(here));
      const other = axes[at + (e.key === "ArrowDown" ? 1 : -1)];
      const theirs = other ? [...other.querySelectorAll<SVGGElement>("[data-mark]")] : [];
      next = theirs[Math.min(theirs.length - 1, i)];
    } else return;
    e.preventDefault();
    next?.focus();
  };

  // A bound has no deviation figure, and a zero reference no percentage: each says which it is.
  const scoredMarks = row.marks.filter((m) => !m.value.isBound);
  const gap = hotMark
    ? w.readout(hotMark.value.shortName, fmt(hotMark.value.estimate), q.unit, deviationText(hotMark), hotMark.value.withinInterval, markNotes(hotMark, q))
    : !row.worst
      ? ""
      : scoredMarks.every((m) => m.value.withinInterval)
        ? w.allInside
        : w.gap(deviationText(row.worst) ?? (q.reference ? w.referenceZero : w.meanZero), row.worst.value.shortName);
  const verdictShown = row.compared ? q.verdict : "single";
  const uncertain = row.uncertain === "wide" ? w.referenceTooWide : row.uncertain === "none" ? w.referenceNoInterval : null;

  return (
    <tr data-quantity={q.key} data-verdict={row.compared ? q.verdict : undefined}>
      <th scope="row" className="agr-quantity">
        {showStation ? <span className="agr-muted">{q.stationName || w.network} · </span> : null}
        {q.metric}
        {q.classLabel !== "All" ? <span className="agr-muted"> · {q.classLabel}</span> : null}
      </th>
      <td className="agr-reference">
        {q.reference ? (
          <>
            <span className="agr-value">{withUnit(q.reference.estimate, q.unit)}</span>
            <span className="agr-source">
              <TierGlyph tier={q.reference.tier} /> {q.reference.shortName}
              {q.reference.interval ? <span className="agr-muted"> · {w.interval(fmt(q.reference.interval.low), fmt(q.reference.interval.high))}</span> : null}
            </span>
            {uncertain ? (
              <span className="agr-source agr-note" data-uncertain={row.uncertain}>
                {uncertain}
              </span>
            ) : null}
          </>
        ) : lone ? (
          <>
            <span className="agr-value">{withUnit(lone.estimate, q.unit)}</span>
            <span className="agr-source">
              <TierGlyph tier={lone.tier} /> {lone.shortName}
              {lone.partial ? <span className="agr-tag" title={w.partialHelp}>{w.partial}</span> : null}
              {lone.isBound ? <span className="agr-tag" title={w.boundHelp}>{w.bound}</span> : null}
            </span>
          </>
        ) : (
          <>
            <span className="agr-value">{withUnit(row.centre, q.unit)}</span>
            <span className="agr-source agr-muted">
              {w.meanOfMethods} · {w.noReference}
            </span>
          </>
        )}
      </td>
      <td className="agr-axis-cell">
        {row.marks.length ? (
          <svg className="agr-axis" data-row={q.key} width="100%" height={ROW_H} role="group" aria-label={w.axisLabel(where)}>
            <rect className="agr-agree-band" x={`${axisPosition(-0.02).x}%`} width={`${axisPosition(0.02).x - axisPosition(-0.02).x}%`} y={3} height={ROW_H - 6} />
            <line className="agr-axis-line" x1={`${AXIS_LEFT}%`} x2={`${AXIS_RIGHT}%`} y1={MID} y2={MID} />
            <line className="agr-axis-tick" x1={`${AXIS_LEFT}%`} x2={`${AXIS_LEFT}%`} y1={MID - 4} y2={MID + 4} />
            <line className="agr-axis-tick" x1={`${AXIS_RIGHT}%`} x2={`${AXIS_RIGHT}%`} y1={MID - 4} y2={MID + 4} />
            {row.band ? <rect className="agr-band" x={`${row.band.x1}%`} width={`${Math.max(0.6, row.band.x2 - row.band.x1)}%`} y={MID - 5} height={10} rx={2} /> : null}
            <line className="agr-axis-zero" x1="50%" x2="50%" y1={2} y2={ROW_H - 2} />
            {row.marks.map((m, i) => (
              <MarkView
                key={m.value.runId}
                mark={m}
                index={i}
                label={w.markLabel(m.value.shortName, w.tierShort[m.value.tier], fmt(m.value.estimate), q.unit, deviationText(m), from, m.value.withinInterval, m.clipped !== 0, markNotes(m, q))}
                active={hotMark === m}
                dimmed={hotMethod !== null && hotMethod !== m.value.method}
                onHot={(on) => onHot(on ? { row: q.key, runId: m.value.runId } : null)}
                onKeyDown={onKeyDown}
              />
            ))}
          </svg>
        ) : only ? (
          <span className="agr-muted">{w.onlyMethod(only.shortName)}</span>
        ) : null}
      </td>
      <td className="agr-gap" aria-live="off">
        {gap}
      </td>
      <td className="agr-verdict" data-verdict={verdictShown} title={uncertain ? `${w.verdictHelp[verdictShown]}. ${uncertain}` : w.verdictHelp[verdictShown]}>
        {row.compared || q.verdict === "exact" ? (
          <>
            <Icon icon={VERDICT_ICON[q.verdict]} size={12} aria-hidden /> {w.verdicts[q.verdict]}
          </>
        ) : (
          <span className="agr-muted">{w.verdicts.single}</span>
        )}
      </td>
    </tr>
  );
}

function MarkView({ mark, index, label, active, dimmed, onHot, onKeyDown }: { mark: Mark; index: number; label: string; active: boolean; dimmed: boolean; onHot: (on: boolean) => void; onKeyDown: (e: KeyboardEvent<SVGGElement>, i: number) => void }) {
  const y = MID + Math.max(-2, Math.min(2, mark.lane)) * LANE;
  const tier = mark.value.tier;
  return (
    <>
      {mark.whisker && mark.clipped === 0 ? <line className="agr-whisker" data-tier={tier} x1={`${mark.whisker.x1}%`} x2={`${mark.whisker.x2}%`} y1={y} y2={y} /> : null}
      <svg x={`${mark.x}%`} y={y} overflow="visible">
        <g
          className="agr-mark"
          data-mark={mark.value.method}
          data-tier={tier}
          data-clipped={mark.clipped || undefined}
          data-partial={mark.value.partial || undefined}
          data-bound={mark.value.isBound || undefined}
          data-active={active || undefined}
          data-dimmed={dimmed || undefined}
          role="img"
          aria-label={label}
          tabIndex={index === 0 ? 0 : -1}
          onFocus={() => onHot(true)}
          onBlur={() => onHot(false)}
          onMouseEnter={() => onHot(true)}
          onMouseLeave={() => onHot(false)}
          onKeyDown={(e) => onKeyDown(e, index)}
        >
          <title>{label}</title>
          <circle className="agr-mark-hit" r={9} />
          {active ? <circle className="agr-mark-ring" r={8} /> : null}
          {mark.clipped ? (
            <path className="agr-mark-shape" d={mark.clipped > 0 ? "M-4 -5 L5 0 L-4 5 Z" : "M4 -5 L-5 0 L4 5 Z"} />
          ) : mark.value.isBound ? (
            // A bound is a limit, not an estimate: a capped bar, never the tier's point shape, and
            // its label says "bound" with no deviation figure.
            <path className="agr-mark-shape" d="M-4 -6 L4 -6 M0 -6 L0 6 M-4 6 L4 6" />
          ) : (
            <g className="agr-mark-shape">
              <TierShape tier={tier} />
            </g>
          )}
        </g>
      </svg>
    </>
  );
}
