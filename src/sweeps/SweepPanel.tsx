// The What-If Sweep panel (new in 2.1, ROADMAP B4): a small form in a movable panel, in the run
// panels' style (src/runs/ui/RunPanels.tsx), filled in from the network — the parameter (a menu
// grouped by kind), a range round its current value that stays stable, the number of points, the
// methods the Method Chooser says apply (the best exact one and the best approximation ticked),
// and the measure and station the chart opens on. One line says what will happen in plain words:
// "12 points × 2 methods; about 3 seconds." Return runs; Escape or Cancel closes.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChartLine, TriangleAlert } from "lucide-react";
import { TIER_STYLE, v } from "../charts";
import { shapePath } from "../charts";
import { Icon } from "../components/Icon";
import { inExportOrder } from "../editor/naming";
import { api } from "../lib/api";
import { PanelWindow } from "../lib/panel";
import { parseNumber } from "../panes/inspector/distributions/numbers";
import { STATION_METRICS } from "../results/insight";
import { PanelHeader } from "../windows/parameters/chrome";
import { useWorkspace } from "../workspace/store";
import { closeSweepPanel, defaultPoints, specOf, summaryLine, sweepHosts, sweepProblem, useSweepPanelRequest, type SweepForm, type SweepPanelRequest } from "./commands";
import { discoverParameters, MAX_POINTS, PARAMETER_KINDS, valueText, type SweepParameter } from "./model";
import { defaultRange, methodsFor, runSweep, type DefaultRange, type MethodChoice } from "./runner";
import { list, sweepWords as w } from "./words";
import "../panes/inspector/inspector.css";
import "../workspace/files/files.css";
import "../runs/ui/runs-ui.css";
import "./sweeps.css";

/** Draws the panel when one is asked for. Mounted in App.tsx beside the other hosts. */
export function SweepHost({ fallback = false }: { fallback?: boolean }) {
  useEffect(() => {
    if (fallback) return;
    sweepHosts.mounted++;
    return () => {
      sweepHosts.mounted--;
    };
  }, [fallback]);
  const r = useSweepPanelRequest();
  // The stand-in host steps aside once a real one is mounted.
  if (fallback && sweepHosts.mounted > 0) return null;
  return r ? <SweepPanel key={r.tabId} request={r} /> : null;
}

// Until App.tsx mounts a host, the first open makes one in a root of its own.
sweepHosts.fallback = () => {
  sweepHosts.fallback = null;
  if (typeof document === "undefined") return;
  createRoot(document.createElement("div")).render(<SweepHost fallback />);
};

/** Return runs unless focus is on a button or a picker (the run panels' rule). */
function onFormKey(e: KeyboardEvent, confirm: () => void) {
  if (e.defaultPrevented || e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
  const t = e.target as HTMLElement;
  if (t.tagName === "BUTTON" || t.tagName === "SELECT" || (t as HTMLInputElement).type === "checkbox") return;
  e.preventDefault();
  confirm();
}

function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="qn-sheet-section" aria-label={title}>
      <h3 className="qn-sheet-section-title">{title}</h3>
      <div className="qn-sheet-rows">{children}</div>
      {footer ? <div className="qn-sheet-section-footer">{footer}</div> : null}
    </section>
  );
}

function Row({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="qn-sheet-row" title={help}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="qn-sheet-label">
          {label}
        </label>
      ) : (
        <span className="qn-sheet-label">{label}</span>
      )}
      <span className="qn-sheet-value">{children}</span>
    </div>
  );
}

/** A tier's mark: its colour and its shape together, as the charts draw it. */
export function TierMark({ tier }: { tier: MethodChoice["tier"] }) {
  const style = TIER_STYLE[tier];
  const hollow = style.shape === "ring" || style.shape === "cross";
  return (
    <svg className="sweep-tier-mark" width={12} height={12} viewBox="-6 -6 12 12" aria-hidden="true">
      <path d={shapePath(style.shape, 0, 0, 4.5)} fill={hollow ? "none" : v(style.color)} stroke={v(style.color)} strokeWidth={hollow ? 1.8 : 0} />
    </svg>
  );
}

function SweepPanel({ request }: { request: SweepPanelRequest }) {
  const uid = useId();
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === request.tabId) ?? null);
  // The network as it was when the panel opened is what the form describes; the sweep itself runs
  // on the network as it is when Run is pressed.
  const doc = tab?.document ?? null;
  const parameters = useMemo(() => (doc ? discoverParameters(doc) : []), [doc]);
  const stations = useMemo(() => (doc ? inExportOrder(doc.nodes.filter((n) => n.kind === "station"), (n) => n.name) : []), [doc]);
  const again = request.from;

  const [form, setForm] = useState<SweepForm>(() => {
    const first = (again && parameters.find((p) => p.id === again.parameter.id)) || parameters[0] || null;
    const from = again && first?.id === again.parameter.id ? again.from : first ? first.current * (first.integer ? 1 : 0.5) : 0;
    const to = again && first?.id === again.parameter.id ? again.to : first ? (first.integer ? first.current + 3 : first.current * 1.5) : 1;
    return {
      parameterId: first?.id ?? "",
      from: valueText(from),
      to: valueText(to),
      points: String(again ? again.values.length : first ? defaultPoints(first, from, to) : 12),
      methods: again ? again.methods.map((m) => m.label) : [],
      metric: again?.metric ?? "Mean number in system",
      stationId: again?.stationId ?? stations[0]?.id ?? null,
    };
  });
  const set = (patch: Partial<SweepForm>) => setForm((f) => ({ ...f, ...patch }));
  const parameter = parameters.find((p) => p.id === form.parameterId) ?? null;

  // The methods that apply, asked of the Method Chooser once.
  const [offered, setOffered] = useState<MethodChoice[] | null>(null);
  useEffect(() => {
    let live = true;
    if (!tab) return;
    void methodsFor(tab).then(
      (list) => {
        if (!live) return;
        setOffered(list);
        setForm((f) => {
          const kept = f.methods.filter((label) => list.some((m) => m.label === label));
          return { ...f, methods: kept.length ? kept : list.filter((m) => m.preferred).map((m) => m.label) };
        });
      },
      () => live && setOffered([]),
    );
    return () => {
      live = false;
    };
    // Asked for the network the panel opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.tabId]);

  // A range that stays stable, found for the parameter in hand — unless the range is the user's own.
  const [range, setRange] = useState<DefaultRange | null>(null);
  const typed = useRef(!!again);
  useEffect(() => {
    let live = true;
    setRange(null);
    if (!doc || !parameter) return;
    void defaultRange(doc, parameter).then((r) => {
      if (!live) return;
      setRange(r);
      if (!typed.current) set({ from: valueText(r.from), to: valueText(r.to), points: String(defaultPoints(parameter, r.from, r.to)) });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.parameterId, request.tabId]);

  // The chart opens on the busiest station, when the network says which that is.
  useEffect(() => {
    let live = true;
    if (!doc || again) return;
    void api.quietProbe(doc).then(
      (probe) => {
        const top = probe.loads.reduce<{ station: string; utilisation: number } | null>((m, l) => (!m || l.utilisation > m.utilisation ? l : m), null);
        const node = top ? stations.find((s) => s.name === top.station) : null;
        if (live && node) setForm((f) => ({ ...f, stationId: node.id }));
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.tabId]);

  const problem = sweepProblem(form, parameter);
  const spec = offered ? specOf(form, parameter, offered) : null;
  const slow = (offered ?? []).filter((m) => m.slow && form.methods.includes(m.label));
  const cancel = () => closeSweepPanel();
  const confirm = () => {
    if (!spec || !tab) return;
    closeSweepPanel();
    void runSweep(tab.id, spec);
  };
  const changeParameter = (id: string) => {
    typed.current = false;
    const p = parameters.find((q) => q.id === id);
    set({ parameterId: id, ...(p ? { from: valueText(p.integer ? Math.max(p.min, p.current - 2) : p.current * 0.5), to: valueText(p.integer ? p.current + 3 : p.current * 1.5) } : {}) });
  };
  const edge = range?.edge ?? null;
  const from = parseNumber(form.from);
  const to = parseNumber(form.to);
  const beyond = edge !== null && from !== null && to !== null && (edge.unstable === "above" ? Math.max(from, to) > edge.x : Math.min(from, to) < edge.x);

  if (!tab || !doc) return null;
  return (
    <PanelWindow id="what-if-sweep" title={w.panelTitle} band="tall" modality="document" onClose={cancel}>
      <div className="panel-form" data-panel="what-if-sweep" onKeyDown={(e) => onFormKey(e, confirm)}>
        <PanelHeader glyph={<Icon icon={ChartLine} size={20} className="run-ui-glyph-info" />} title={w.panelTitle} subtitle={w.panelSubtitle(tab.title)} />
        <div className="panel-content">
          <form className="run-ui-form" aria-label={w.panelTitle} onSubmit={(e) => e.preventDefault()}>
            <Section
              title={w.sectionQuestion}
              footer={
                parameter ? (
                  <>
                    <span data-sweep-now>{w.nowIs(valueText(parameter.current), parameter.unit)}.</span>
                    {beyond && edge ? (
                      <span className="sweep-panel-warning" role="status">
                        {" "}
                        {edge.unstable === "above" ? w.stableUpTo(valueText(Number(edge.x.toPrecision(4)))) : w.stableFrom(valueText(Number(edge.x.toPrecision(4))))}
                      </span>
                    ) : null}
                  </>
                ) : (
                  w.nothingToVary
                )
              }
            >
              <Row label={w.parameter} help={w.parameterHelp} htmlFor={`${uid}-parameter`}>
                <select id={`${uid}-parameter`} className="qn-field sweep-panel-wide" title={w.parameterHelp} value={form.parameterId} onChange={(e) => changeParameter(e.target.value)}>
                  {PARAMETER_KINDS.filter((k) => parameters.some((p) => p.kind === k)).map((k) => (
                    <optgroup key={k} label={w.groups[k]}>
                      {parameters
                        .filter((p) => p.kind === k)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </Row>
              <Row label={w.from} help={parameter ? w.rangeHelp(valueText(parameter.current)) : undefined} htmlFor={`${uid}-from`}>
                <RangeField id={`${uid}-from`} label={w.from} value={form.from} parameter={parameter} onChange={(t) => ((typed.current = true), set({ from: t }))} />
              </Row>
              <Row label={w.to} help={parameter ? w.rangeHelp(valueText(parameter.current)) : undefined} htmlFor={`${uid}-to`}>
                <RangeField id={`${uid}-to`} label={w.to} value={form.to} parameter={parameter} onChange={(t) => ((typed.current = true), set({ to: t }))} />
              </Row>
              <Row label={w.points} help={w.pointsHelp(MAX_POINTS)} htmlFor={`${uid}-points`}>
                <input id={`${uid}-points`} className="qn-field qn-field-compact" type="text" inputMode="numeric" aria-label={w.points} value={form.points} onChange={(e) => set({ points: e.target.value })} />
              </Row>
            </Section>

            <Section
              title={w.sectionMethods}
              footer={
                slow.length ? (
                  <span className="sweep-panel-warning" role="status">
                    <Icon icon={TriangleAlert} size={12} aria-hidden /> {w.slowWarning(list(slow.map((m) => m.name)))}
                  </span>
                ) : undefined
              }
            >
              {offered === null ? (
                <div className="qn-sheet-row muted">{w.methodsFinding}</div>
              ) : !offered.length ? (
                <div className="qn-sheet-row muted">{w.methodsNone}</div>
              ) : (
                offered.map((m) => {
                  const id = `${uid}-method-${m.label}`;
                  const ticked = form.methods.includes(m.label);
                  return (
                    <label key={m.label} className="qn-sheet-row sweep-panel-method" htmlFor={id} title={m.slow ? w.methodHelpSimulation(m.name, w.tiers[m.tier]) : m.measured ? w.methodHelp(m.name, w.tiers[m.tier], m.seconds < 1 ? "under a second" : `about ${Math.round(m.seconds)} s`) : w.methodHelpUnmeasured(m.name, w.tiers[m.tier])}>
                      <input id={id} type="checkbox" checked={ticked} data-method={m.label} onChange={() => set({ methods: ticked ? form.methods.filter((l) => l !== m.label) : [...form.methods, m.label] })} />
                      <TierMark tier={m.tier} />
                      <span className="qn-sheet-label">{m.name}</span>
                      <span className="muted sweep-panel-tier">{w.tiers[m.tier]}</span>
                    </label>
                  );
                })
              )}
            </Section>

            <Section title={w.sectionMeasure}>
              <Row label={w.measure} help={w.measureHelp} htmlFor={`${uid}-measure`}>
                <select id={`${uid}-measure`} className="qn-field sweep-panel-wide" title={w.measureHelp} value={form.metric} onChange={(e) => set({ metric: e.target.value })}>
                  {STATION_METRICS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={w.station} help={w.stationHelp} htmlFor={`${uid}-station`}>
                <select id={`${uid}-station`} className="qn-field sweep-panel-wide" title={w.stationHelp} value={form.stationId ?? ""} onChange={(e) => set({ stationId: e.target.value || null })}>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Row>
            </Section>
          </form>
        </div>
        <footer className="panel-footer">
          <div className="panel-footer-note">
            {problem ? (
              <span className="qn-sheet-problem" role="status">
                {problem}
              </span>
            ) : (
              <span className="sweep-panel-summary" role="status" data-sweep-summary>
                {offered ? summaryLine(form, parameter, offered) : ""}
              </span>
            )}
          </div>
          <button type="button" className="btn" title={w.cancelHelp} aria-keyshortcuts="Escape" onClick={cancel}>
            {w.cancel}
          </button>
          <button type="button" className="btn primary" title={problem ? w.runBlocked : w.runHelp} aria-keyshortcuts="Enter" disabled={!spec} onClick={confirm}>
            {w.run}
          </button>
        </footer>
      </div>
    </PanelWindow>
  );
}

/** From and To: free typing; a value the parameter can't take is marked. */
function RangeField({ id, label, value, parameter, onChange }: { id: string; label: string; value: string; parameter: SweepParameter | null; onChange: (text: string) => void }) {
  const x = parseNumber(value);
  const bad = x === null || (parameter !== null && parameter.integer && !Number.isInteger(x));
  return (
    <span className="run-ui-range">
      <input id={id} className="qn-field qn-field-compact sweep-panel-number" type="text" inputMode="decimal" aria-label={label} aria-invalid={bad || undefined} value={value} onChange={(e) => onChange(e.target.value)} />
      {parameter?.unit ? <span className="muted run-ui-unit">{parameter.unit}</span> : null}
    </span>
  );
}
