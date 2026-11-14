// The flag bar under the Status header: Analytical, Re-entrant and Warnings pills, each opening a
// popover that explains its state (0.90.34 FlagBarView.swift; ledger LOG-031, LOG-033…039). It shows
// the active tab's latest silent analysis (./analysis.ts); nothing here computes anything.
import { useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, Badge, CircleCheck, CircleCheckBig, CircleHelp, OctagonX, RefreshCw, TriangleAlert } from "lucide-react";
import { Icon } from "../../components/Icon";
import type { SilentAnalysis } from "../../lib/types";
import type { Tab } from "../../workspace/store";
import { useAnalysis, useHasBeenAnalyzed } from "./analysis";
import { Popover } from "./popup";
import { statusWords as w } from "./words";

type Tint = "good" | "warn" | "crit" | "muted";
type Quality = SilentAnalysis["feedbackQuality"];

const QUALITY_TINT: Record<Quality, Tint> = { green: "good", yellow: "warn", red: "crit", notReentrant: "muted" };

let numberFormat: Intl.NumberFormat | null = null;

/** A derived readout: up to 5 significant digits in the locale's form, "—" for NaN, "∞" for an infinity (`DS.Number.format`). */
export function readout(v: number | string): string {
  const x = Number(v);
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "—" : "∞";
  numberFormat ??= new Intl.NumberFormat(undefined, { minimumSignificantDigits: 1, maximumSignificantDigits: 5 });
  return numberFormat.format(x);
}

function Pill({ title, icon, on, tint, badge, help, offHelp, hint, children }: { title: string; icon: LucideIcon; on: boolean; tint: Tint; badge?: number; help: string; offHelp: string; hint: string; children: () => ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="status-pill"
        data-on={on || undefined}
        data-tint={tint}
        title={on ? help : offHelp}
        aria-label={w.pillLabel(title, on, badge)}
        aria-description={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={icon} size={12} aria-hidden />
        <span>{title}</span>
        {badge !== undefined ? <span className="status-pill-badge" aria-hidden>{badge}</span> : null}
      </button>
      {open && ref.current ? (
        <Popover anchor={ref.current} label={title} onClose={() => setOpen(false)}>
          {children()}
        </Popover>
      ) : null}
    </>
  );
}

/** A popover's title row (DSPopover: icon, title, trailing word). */
function Head({ icon, tint, title, trailing }: { icon: LucideIcon; tint: Tint; title: string; trailing: string }) {
  return (
    <div className="status-popover-title" data-tint={tint}>
      <Icon icon={icon} size={14} aria-hidden />
      <strong>{title}</strong>
      <span className="spacer" />
      <span className="status-popover-trailing">{trailing}</span>
    </div>
  );
}

const Rule = () => <hr className="status-rule" />;

function AnalyticalDetail({ a, empty, analysed }: { a: SilentAnalysis | null; empty: boolean; analysed: boolean }) {
  const on = !!a?.isAnalyticallyTractable;
  if (!a || !on) {
    const why = empty ? w.whyEmpty : !analysed ? w.whyNotAnalysed : a?.tractabilityExplanation ? a.tractabilityExplanation : w.whyNoMatch;
    const nonExp = empty ? [] : a?.nonExponentialStations ?? [];
    return (
      <>
        <Head icon={Badge} tint="muted" title={w.analytical} trailing={w.notTractable} />
        <p className="status-callout">{why}</p>
        {nonExp.length ? (
          <>
            <Rule />
            <p className="status-caption">{w.nonExponential}</p>
            {nonExp.map((l) => (
              <div key={l} className="status-number">{l}</div>
            ))}
          </>
        ) : null}
        <Rule />
        <p className="status-caption">{w.tractableCases}</p>
      </>
    );
  }
  const label = a.tractabilityMeansLabel || w.meansLabel;
  const gammas = a.throughputs;
  const nothing = !a.tractabilityTitle && !a.tractabilityDetail && !a.tractabilityExplanation && !a.tractabilityMeans.length;
  return (
    <>
      <Head icon={BadgeCheck} tint="good" title={w.analytical} trailing={a.tractabilityIsExact ? w.exact : w.asymptotic} />
      {a.tractabilityTitle ? <p className="status-subhead">{a.tractabilityTitle}</p> : null}
      {a.tractabilityDetail ? <p className="status-callout">{a.tractabilityDetail}</p> : null}
      {a.tractabilityExplanation ? (
        <>
          <Rule />
          <p className="status-callout status-prewrap">{a.tractabilityExplanation}</p>
        </>
      ) : null}
      {a.tractabilityMeans.length ? (
        <>
          <Rule />
          <p className="status-caption">{gammas ? w.meansAndGamma(label) : label}</p>
          <table className="status-means" title={w.gridHelp(label, a.tractabilityTitle)}>
            {gammas ? (
              <thead>
                <tr>
                  <th>{w.station}</th>
                  <th className="num">{w.mean}</th>
                  <th className="num">
                    {w.gamma}{" "}
                    <span className="status-glossary" title={w.gammaGlossary} aria-label={w.gammaGlossaryLabel} role="img">
                      <Icon icon={CircleHelp} size={12} aria-hidden />
                    </span>
                  </th>
                </tr>
              </thead>
            ) : null}
            <tbody>
              {a.tractabilityMeans.map((v, i) => (
                <tr key={i}>
                  <td>{a.stationNames[i] ?? `S${i + 1}`}</td>
                  <td className="num">{readout(v)}</td>
                  {gammas && i < gammas.length ? <td className="num">{readout(gammas[i])}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
          {a.stationOrderIsAmbiguous ? (
            <p className="status-inline-warning">
              <Icon icon={TriangleAlert} size={12} aria-hidden /> {w.ambiguousOrder}
            </p>
          ) : null}
        </>
      ) : null}
      {nothing ? <p className="status-callout">{w.knownClosedForm}</p> : null}
    </>
  );
}

function ReentrantDetail({ a, empty, analysed }: { a: SilentAnalysis | null; empty: boolean; analysed: boolean }) {
  const q: Quality = a?.feedbackQuality ?? "notReentrant";
  const lead = a?.hasFeedback ? w.hasCycle : empty ? w.emptyCanvas : !analysed ? w.reentrantNotAnalysed : w.noCycle;
  return (
    <>
      <Head icon={RefreshCw} tint={QUALITY_TINT[q]} title={w.reentrant} trailing={w.reentrantHeadline[q]} />
      <p className="status-callout">{lead}</p>
      {a?.feedbackDescription ? (
        <>
          <Rule />
          <p className="status-mono status-prewrap">{a.feedbackDescription}</p>
        </>
      ) : null}
      {a?.feedbackCriteria.length ? (
        <>
          <Rule />
          <p className="status-caption">{w.criteria}</p>
          <ul className="status-criteria">
            {a.feedbackCriteria.map((c, i) => (
              <li key={i}>
                <span className="status-criterion-mark" data-ok={c.ok} role="img" aria-label={c.ok ? w.passed : w.failed}>
                  <Icon icon={c.ok ? CircleCheckBig : OctagonX} size={14} aria-hidden />
                </span>
                <span>
                  <span className="status-callout">{c.label}</span>
                  <span className="status-caption">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Rule />
      <p className="status-caption">{w.implication[q]}</p>
    </>
  );
}

function WarningDetail({ a, empty, analysed }: { a: SilentAnalysis | null; empty: boolean; analysed: boolean }) {
  const list = a?.warnings ?? [];
  const on = list.length > 0;
  return (
    <>
      <Head icon={on ? TriangleAlert : CircleCheck} tint={on ? "warn" : "good"} title={w.warnings} trailing={on ? w.issues(list.length) : w.none} />
      {!on ? (
        <p className="status-callout">{empty ? w.emptyCanvas : !analysed ? w.warningsNotAnalysed : w.noProblems}</p>
      ) : (
        <ul className="status-warning-list">
          {list.map((x, i) => (
            <li key={i}>
              <Icon icon={TriangleAlert} size={12} aria-hidden />
              <span>{x}</span>
            </li>
          ))}
        </ul>
      )}
      <Rule />
      <p className="status-caption">{w.primitivesHint}</p>
    </>
  );
}

export function FlagBar({ tab }: { tab: Tab }) {
  const a = useAnalysis(tab.id);
  const analysed = useHasBeenAnalyzed(tab);
  const empty = tab.document.nodes.length === 0;
  const tractable = !!a?.isAnalyticallyTractable;
  const q: Quality = a?.feedbackQuality ?? "notReentrant";
  const warnings = a?.warnings ?? [];
  const props = { a, empty, analysed };
  return (
    <div className="status-flagbar" role="group" aria-label={w.flagsLabel}>
      <Pill title={w.analytical} icon={BadgeCheck} on={tractable} tint="good" help={a?.tractabilityTitle || w.analyticalHelp} offHelp={w.analyticalOff} hint={w.analyticalHint}>
        {() => <AnalyticalDetail {...props} />}
      </Pill>
      <Pill title={w.reentrant} icon={RefreshCw} on={!!a?.hasFeedback} tint={QUALITY_TINT[q]} help={w.reentrantHelp[q]} offHelp={w.reentrantOff} hint={w.reentrantHint}>
        {() => <ReentrantDetail {...props} />}
      </Pill>
      <Pill
        title={w.warnings}
        icon={TriangleAlert}
        on={warnings.length > 0}
        tint="warn"
        badge={warnings.length > 0 ? Math.max(warnings.length, 1) : undefined}
        help={w.warningsHelp(warnings.length)}
        offHelp={w.warningsOff}
        hint={w.warningsHint}
      >
        {() => <WarningDetail {...props} />}
      </Pill>
    </div>
  );
}
