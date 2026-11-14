// The inspector's sections for the model features new in 2.1 (core/src/extended.rs): a
// station's order of service, and a source's batch sizes and rate over time. Unlike the node's
// draft form above them, each control here writes the document at once, as one undoable step
// (as the closed network's population does): a discipline, an order or a profile is a choice,
// not a number being typed. Text fields commit when what is typed parses.
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { BatchSize, BnetNode, RateProfile, ServiceDiscipline } from "../lib/bnet";
import { classLabel, type Editor } from "../editor";
import { formatSig } from "../editor/numbers";
import { isDistribution } from "../editor/distributions";
import { meanOfString } from "../panes/inspector/distributions/families";
import { Icon } from "../components/Icon";
import { ClassChip, InlineMessage, MenuPicker, Row } from "../panes/inspector/fields";
import { Section } from "../panes/inspector/NodeSections";
import { looksClosed } from "../closed/shape";
import { batchIsValid, batchMean, profileMean, profileProblem } from "./model";
import { DISCIPLINE_NAMES, extendedWords as w, type BatchKind } from "./words";
import "./extended.css";

const DISCIPLINES: readonly ServiceDiscipline[] = ["fcfs", "priorityNonPreemptive", "priorityPreemptiveResume"];

/** Text a number field shows for `value`, and what it holds while being typed; reset when `key` changes. */
function useText(value: string, key: string): [string, (t: string) => void] {
  const [text, setText] = useState(value);
  // Undo, a fix or another node: the document's value replaces what was typed.
  useEffect(() => setText(value), [value, key]);
  return [text, setText];
}

const num = (t: string): number | null => {
  const s = t.trim();
  if (s === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** True when `node` has feature sections: a source, or a station of a network that is not closed. */
export function hasFeatureSections(editor: Editor, node: BnetNode): boolean {
  return node.kind === "source" || (node.kind === "station" && !looksClosed(editor.nodes));
}

/**
 * The sections for `node`, or nothing for a buffer, a sink, or a station of a closed network.
 * `host` "sheet" is the Node Parameters panel, whose other fields wait for Save: there a line
 * says first that these settings are written as they are changed.
 */
export function FeatureSections({ editor, node, host = "pane" }: { editor: Editor; node: BnetNode; host?: "pane" | "sheet" }) {
  if (!hasFeatureSections(editor, node)) return null;
  return (
    <>
      {host === "sheet" ? (
        <p className="insp-caption" role="note">
          {w.appliesAtOnce}
        </p>
      ) : null}
      {node.kind === "station" ? (
        <ServiceOrderSection editor={editor} node={node} />
      ) : (
        <>
          <BatchSection editor={editor} node={node} />
          <RateProfileSection editor={editor} node={node} />
        </>
      )}
    </>
  );
}

// ── Station: order of service ──────────────────────────────────────────────────────────────────

/** Every class of the network in the station's order: the stored order first, then the rest by number. */
export function fullOrder(stored: readonly number[] | undefined, classes: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of stored ?? []) {
    if (Number.isInteger(c) && c >= 0 && c < classes && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  for (let c = 0; c < classes; c++) if (!seen.has(c)) out.push(c);
  return out;
}

function ServiceOrderSection({ editor, node }: { editor: Editor; node: BnetNode }) {
  const discipline = node.serviceDiscipline ?? "fcfs";
  const classes = Math.max(1, editor.numberOfCustomerClasses);
  const order = fullOrder(node.priorityOrder, classes);
  const served = new Set(editor.classesServedAtStation(node.id));
  const [said, setSaid] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const move = (at: number, by: -1 | 1) => {
    const to = at + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[at], next[to]] = [next[to], next[at]];
    editor.updateServiceDiscipline(node.id, discipline, next);
    setSaid(w.moved(classLabel(order[at]), to + 1, order.length));
    // Focus follows the class that moved, so it can be moved again.
    const doc = list.current?.ownerDocument;
    doc?.defaultView?.requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-class="${order[at]}"]`)?.focus());
  };
  return (
    <Section title={w.orderSection}>
      <MenuPicker label={w.discipline} help={w.disciplineHelp} glossary={w.disciplineGlossary} width="wide" value={discipline} options={DISCIPLINES.map((d) => ({ value: d, label: DISCIPLINE_NAMES[d] }))} onChange={(d) => editor.updateServiceDiscipline(node.id, d, order)} />
      {discipline === "fcfs" ? (
        <p className="insp-caption">{w.fcfsCaption}</p>
      ) : (
        <>
          <ol ref={list} className="ext-order" aria-label={w.orderLabel}>
            {order.map((c, i) => (
              <li
                key={c}
                className="ext-order-row"
                tabIndex={0}
                data-class={c}
                aria-label={`${w.rank(i + 1)} ${classLabel(c)}${served.has(c) ? "" : `, ${w.notServed}`}`}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(i, e.key === "ArrowUp" ? -1 : 1);
                }}
              >
                <span className="ext-order-rank">{w.rank(i + 1)}</span>
                <ClassChip index={c} />
                {served.has(c) ? null : <span className="muted ext-order-note">{w.notServed}</span>}
                <span className="ext-order-buttons">
                  <button type="button" className="icon-btn" aria-label={w.moveUp(classLabel(c))} title={w.moveUp(classLabel(c))} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon icon={ArrowUp} size={12} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={w.moveDown(classLabel(c))} title={w.moveDown(classLabel(c))} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                    <Icon icon={ArrowDown} size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <p className="insp-caption">{classes <= 1 ? w.oneClass : w.orderCaption}</p>
          <span className="sr-only" role="status" aria-live="polite">
            {said}
          </span>
        </>
      )}
    </Section>
  );
}

// ── Source: batches ────────────────────────────────────────────────────────────────────────────

const kindOf = (b: BatchSize | undefined): BatchKind => (b ? b.kind : "single");
const pmfText = (p: readonly number[]) => p.map((x) => String(x)).join(", ");

function BatchSection({ editor, node }: { editor: Editor; node: BnetNode }) {
  const batch = node.batchSize;
  const kind = kindOf(batch);
  const [size, setSize] = useText(batch?.kind === "constant" ? String(batch.size) : "2", node.id);
  const [mean, setMean] = useText(batch?.kind === "geometric" ? String(batch.mean) : "2", node.id);
  const [pmf, setPmf] = useText(batch?.kind === "pmf" ? pmfText(batch.probabilities) : "0.5, 0.5", node.id);
  const id = useId();

  const choose = (k: BatchKind) => {
    if (k === "single") editor.updateBatchSize(node.id, null);
    else if (k === "constant") editor.updateBatchSize(node.id, { kind: "constant", size: Math.max(1, Math.round(num(size) ?? 2)) });
    else if (k === "geometric") editor.updateBatchSize(node.id, { kind: "geometric", mean: Math.max(1, num(mean) ?? 2) });
    else editor.updateBatchSize(node.id, { kind: "pmf", probabilities: parsePmf(pmf) ?? [0.5, 0.5] });
  };

  const sizeValue = num(size);
  const sizeError = kind === "constant" && (sizeValue === null || !Number.isInteger(sizeValue) || sizeValue < 1) ? w.batchWhole : null;
  const meanValue = num(mean);
  const meanError = kind === "geometric" && (meanValue === null || meanValue < 1) ? w.batchMeanAtLeastOne : null;
  const probabilities = parsePmf(pmf);
  const sum = probabilities?.reduce((s, p) => s + p, 0) ?? 0;
  const pmfError = kind !== "pmf" ? null : probabilities === null ? w.batchPmfNotNumbers : Math.abs(sum - 1) > 1e-9 ? w.batchPmfSum(formatSig(sum, 6)) : null;

  // The source's own rate, 1/(mean inter-arrival time), as the inspector reads it above.
  const between = isDistribution(node.distribution) ? meanOfString(node.distribution, node.distributionParameters) : null;
  const perTime = between !== null && between > 0 ? 1 / between : NaN;
  const valid = batch !== undefined && batchIsValid(batch);
  return (
    <Section title={w.batchSection}>
      <MenuPicker<BatchKind> label={w.batchKind} help={w.batchKindHelp} glossary={w.batchGlossary} width="wide" value={kind} options={(["single", "constant", "geometric", "pmf"] as const).map((k) => ({ value: k, label: w.batchKinds[k] }))} onChange={choose} />
      {kind === "constant" ? (
        <Row label={w.batchConstant} help={w.batchConstantHelp} error={sizeError} labelFor={`${id}-size`}>
          <span className="insp-field-line">
            <input
              id={`${id}-size`}
              className={`insp-input insp-number w-field${sizeError ? " is-invalid" : ""}`}
              inputMode="numeric"
              value={size}
              aria-invalid={sizeError ? true : undefined}
              title={w.batchConstantHelp}
              onChange={(e) => {
                setSize(e.target.value);
                const v = num(e.target.value);
                if (v !== null && Number.isInteger(v) && v >= 1) editor.updateBatchSize(node.id, { kind: "constant", size: v });
              }}
            />
            <span className="insp-unit">{w.customers}</span>
          </span>
        </Row>
      ) : null}
      {kind === "geometric" ? (
        <Row label={w.batchGeometric} help={w.batchGeometricHelp} error={meanError} labelFor={`${id}-mean`}>
          <span className="insp-field-line">
            <input
              id={`${id}-mean`}
              className={`insp-input insp-number w-field${meanError ? " is-invalid" : ""}`}
              inputMode="decimal"
              value={mean}
              aria-invalid={meanError ? true : undefined}
              title={w.batchGeometricHelp}
              onChange={(e) => {
                setMean(e.target.value);
                const v = num(e.target.value);
                if (v !== null && v >= 1) editor.updateBatchSize(node.id, { kind: "geometric", mean: v });
              }}
            />
            <span className="insp-unit">{w.customers}</span>
          </span>
        </Row>
      ) : null}
      {kind === "pmf" ? (
        <Row label={w.batchPmf} help={w.batchPmfHelp} error={pmfError} labelFor={`${id}-pmf`}>
          <input
            id={`${id}-pmf`}
            className={`insp-input ext-pmf${pmfError ? " is-invalid" : ""}`}
            value={pmf}
            placeholder={w.batchPmfPlaceholder}
            aria-invalid={pmfError ? true : undefined}
            title={w.batchPmfHelp}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setPmf(e.target.value);
              // What parses is stored, also when it does not sum to 1 yet: Problems says so too.
              const p = parsePmf(e.target.value);
              if (p !== null) editor.updateBatchSize(node.id, { kind: "pmf", probabilities: p });
            }}
          />
        </Row>
      ) : null}
      {batch && valid ? <p className="insp-caption">{w.batchReadout(formatSig(batchMean(batch), 5), Number.isFinite(perTime) && perTime > 0 ? formatSig(perTime * batchMean(batch), 5) : null)}</p> : null}
    </Section>
  );
}

/** "0.5, 0.3, 0.2" as numbers, or null when a piece is not a number 0 or more (or there is none). */
export function parsePmf(text: string): number[] | null {
  const parts = text.split(/[,;\s]+/).filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 64) return null;
  const out = parts.map(num);
  return out.every((v) => v !== null && v >= 0) ? (out as number[]) : null;
}

// ── Source: rate over time ─────────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE: RateProfile = { periodic: false, segments: [{ until: 10, multiplier: 2 }] };

function RateProfileSection({ editor, node }: { editor: Editor; node: BnetNode }) {
  const profile = node.rateProfile;
  // The rows as typed: text per cell, replaced by the document's when it changes underneath.
  const stored = JSON.stringify(profile?.segments ?? []);
  const [rows, setRows] = useState(() => (profile?.segments ?? []).map((s) => ({ until: String(s.until), multiplier: String(s.multiplier) })));
  const typed = useRef(stored);
  useEffect(() => {
    if (typed.current !== stored) {
      typed.current = stored;
      setRows((profile?.segments ?? []).map((s) => ({ until: String(s.until), multiplier: String(s.multiplier) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, node.id]);

  const write = (next: { until: string; multiplier: string }[], periodic: boolean) => {
    setRows(next);
    const segments = next.map((r) => ({ until: num(r.until), multiplier: num(r.multiplier) }));
    // Every cell a number: stored, also when a segment has no length yet (Problems says so too).
    if (segments.length > 0 && segments.every((s) => s.until !== null && s.multiplier !== null)) {
      const value = { periodic, segments: segments as { until: number; multiplier: number }[] };
      typed.current = JSON.stringify(value.segments);
      editor.updateRateProfile(node.id, value);
    }
  };
  const poisson = node.distribution === "poisson" || node.distribution === "exponential";
  const problem = profile ? profileProblem(profile) : null;
  const cellError = rows.some((r) => num(r.until) === null || num(r.multiplier) === null);
  return (
    <Section title={w.profileSection}>
      <MenuPicker<"constant" | "varying">
        label={w.profileKind}
        help={w.profileKindHelp}
        glossary={w.profileGlossary}
        value={profile ? "varying" : "constant"}
        options={[
          { value: "constant", label: w.profileKinds.constant },
          { value: "varying", label: w.profileKinds.varying },
        ]}
        onChange={(k) => editor.updateRateProfile(node.id, k === "constant" ? null : DEFAULT_PROFILE)}
      />
      {profile ? (
        <>
          <table className="ext-profile">
            <thead>
              <tr>
                <th scope="col">{w.profileHeadUntil}</th>
                <th scope="col">{w.profileHeadMultiplier}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input className={`insp-input insp-number${num(r.until) === null || (problem?.segment === i + 1 && problem.what === "length") ? " is-invalid" : ""}`} inputMode="decimal" value={r.until} aria-label={w.profileUntil(i + 1)} onChange={(e) => write(rows.map((x, j) => (j === i ? { ...x, until: e.target.value } : x)), profile.periodic)} />
                  </td>
                  <td>
                    <input className={`insp-input insp-number${num(r.multiplier) === null || (problem?.segment === i + 1 && problem.what === "multiplier") ? " is-invalid" : ""}`} inputMode="decimal" value={r.multiplier} aria-label={w.profileMultiplier(i + 1)} onChange={(e) => write(rows.map((x, j) => (j === i ? { ...x, multiplier: e.target.value } : x)), profile.periodic)} />
                  </td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={w.profileRemove(i + 1)} title={w.profileRemove(i + 1)} disabled={rows.length <= 1} onClick={() => write(rows.filter((_, j) => j !== i), profile.periodic)}>
                      <Icon icon={X} size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ext-profile-tools">
            <button
              type="button"
              className="btn"
              disabled={rows.length >= 48}
              onClick={() => {
                const last = num(rows[rows.length - 1]?.until ?? "0") ?? 0;
                const before = num(rows[rows.length - 2]?.until ?? "0") ?? 0;
                write([...rows, { until: String(+(last + Math.max(last - before, 1)).toPrecision(12)), multiplier: "1" }], profile.periodic);
              }}
            >
              <Icon icon={Plus} size={12} /> {w.profileAdd}
            </button>
            <label className="ext-check" title={w.profilePeriodicHelp}>
              <input type="checkbox" checked={profile.periodic} onChange={(e) => editor.updateRateProfile(node.id, { ...profile, periodic: e.target.checked })} /> {w.profilePeriodic}
            </label>
          </div>
          {cellError ? <InlineMessage message={w.enterNumbers} severity="error" /> : problem ? <InlineMessage message={problem.what === "length" ? w.profileNoLength(problem.segment) : w.profileBadMultiplier(problem.segment)} severity="error" /> : null}
          {!poisson ? <InlineMessage message={w.profileNeedsPoisson} severity="warning" /> : null}
          {problem ? null : <ProfileChart profile={profile} />}
          {problem ? null : <p className="insp-caption">{profile.periodic ? w.profileCaptionPeriodic(formatSig(profile.segments[profile.segments.length - 1].until, 5), formatSig(profileMean(profile), 4)) : w.profileCaptionOnce(formatSig(profile.segments[profile.segments.length - 1].until, 5))}</p>}
        </>
      ) : null}
    </Section>
  );
}

/** A small step chart of the multiplier over time: the profile once, then what follows it. */
export function ProfileChart({ profile }: { profile: RateProfile }) {
  const [W, H, L, B, T] = [220, 64, 22, 14, 6];
  const span = profile.segments[profile.segments.length - 1].until;
  // A one-off profile is followed by a stretch at 1; a periodic one by the start of its repeat.
  const shown = span * 1.25;
  const top = Math.max(1, ...profile.segments.map((s) => s.multiplier)) * 1.1;
  const x = (t: number) => L + ((W - L - 4) * t) / shown;
  const y = (m: number) => T + (H - T - B) * (1 - m / top);
  const pieces: { from: number; to: number; m: number }[] = [];
  let last = 0;
  for (const s of profile.segments) {
    pieces.push({ from: last, to: s.until, m: s.multiplier });
    last = s.until;
  }
  if (profile.periodic) {
    let base = span;
    for (const s of profile.segments) {
      if (base >= shown) break;
      pieces.push({ from: base, to: Math.min(shown, span + s.until), m: s.multiplier });
      base = span + s.until;
    }
  } else pieces.push({ from: span, to: shown, m: 1 });
  let d = "";
  pieces.forEach((p, i) => {
    d += `${i === 0 ? "M" : "L"}${x(p.from).toFixed(1)},${y(p.m).toFixed(1)} L${x(p.to).toFixed(1)},${y(p.m).toFixed(1)} `;
  });
  return (
    <svg className="ext-chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={w.profileChartLabel(profile.segments.length, profile.periodic)}>
      <line className="ext-chart-axis" x1={L} y1={y(0)} x2={W - 4} y2={y(0)} />
      <line className="ext-chart-one" x1={L} y1={y(1)} x2={W - 4} y2={y(1)} />
      <line className="ext-chart-end" x1={x(span)} y1={T} x2={x(span)} y2={y(0)} />
      <path className="ext-chart-line" d={d.trim()} />
      <text className="ext-chart-tick" x={L - 3} y={y(1) + 3} textAnchor="end">
        1
      </text>
      <text className="ext-chart-tick" x={L - 3} y={y(0) + 3} textAnchor="end">
        0
      </text>
      <text className="ext-chart-tick" x={x(span)} y={H - 2} textAnchor="middle">
        {formatSig(span, 4)}
      </text>
      <text className="ext-chart-tick" x={W - 4} y={H - 2} textAnchor="end">
        {w.profileAxisTime}
      </text>
    </svg>
  );
}
