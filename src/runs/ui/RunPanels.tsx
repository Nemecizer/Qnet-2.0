// The run panels (0.90.34 RunParameterSheet.swift in a DSPanelWindow "run-parameters";
// TestSetRunner.swift's `TestSetParameterSheet` in "test-set" and
// `SpectralConvergenceParameterSheet` in "spectral-convergence"; ledger METH-009…014,
// METH-132…137, METH-146, METH-147, TEST-001…006, TEST-021…023): movable, document-modal panels
// titled as the sheet, sized by its band. Escape and Cancel cancel; closing the window any other
// way cancels too; Return runs when nothing blocks it.
//
// `RunPanelsHost` renders whichever is open; the lead mounts it in App.tsx.
// A sheet's "?" always opens the Help window on its article, whatever the destination setting (HELP-093).
import { openHelp } from "../../windows/help/state";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, CircleHelp, FlaskConical, Minus, Plus, Play, TrendingDown } from "lucide-react";
import { Icon } from "../../components/Icon";
import { CountField, parseCount } from "../../components/CountField";
import { setSettings } from "../../lib/kv";
import { PanelWindow } from "../../lib/panel";
import { PanelHeader } from "../../windows/parameters/chrome";
import { Glossary } from "../../workspace/files/Sheet";
import { parseNumber } from "../../workspace/files/generate";
import { addStatus } from "../../workspace/store";
import { closePanel, usePanelRequest, type PanelRequest } from "./panels";
import { allFields, initialForm, sheetProblem, sheetValues, topicTitle, type FormState, type SheetField, type SheetSpec, type SheetValues } from "./specs";
import { startSweep } from "./sweeps";
import {
  CLASS_RANGE,
  RHO_RANGE,
  SEED_RANGE,
  SPC_CASES,
  STATION_RANGE,
  TEST_CASES,

  spectralConvergenceParams,
  spectralConvergenceProblem,
  spectralConvergenceSummary,
  testSetParams,
  testSetProblem,
  testSetSummary,
  type SpectralConvergenceForm,
  type TestSetForm,
} from "./testsets";
import { runWords as w } from "./words";
import "../../panes/inspector/inspector.css";
import "../../workspace/files/files.css";
import "./runs-ui.css";

export function RunPanelsHost() {
  const r = usePanelRequest();
  if (!r) return null;
  if (r.kind === "run") return <RunParameterPanel key={r.spec.kind + r.tabId} request={r} />;
  if (r.kind === "test-set") return <TestSetPanel key={`ts-${r.infinite}`} request={r} />;
  return <SpectralConvergencePanel request={r} />;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────────────────────

/** Return confirms unless focus is on a button or a picker; Escape is the window's (cancel). */
function onFormKey(e: KeyboardEvent, confirm: () => void) {
  if (e.defaultPrevented || e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
  const t = e.target as HTMLElement;
  if (t.tagName === "BUTTON" || t.tagName === "SELECT") return;
  // Let the field commit (and clamp) first.
  (t as HTMLInputElement).blur?.();
  e.preventDefault();
  confirm();
}

function Section({ title, footer, notice, children }: { title: string; footer?: ReactNode; notice?: string; children: ReactNode }) {
  return (
    <section className="qn-sheet-section" aria-label={title}>
      <h3 className="qn-sheet-section-title">{title}</h3>
      <div className="qn-sheet-rows">{children}</div>
      {notice ? <p className="qn-sheet-section-notice" role="alert">{notice}</p> : null}
      {footer ? <p className="qn-sheet-section-footer">{footer}</p> : null}
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

/**
 * DSNumericField over a Double, or over an Int with a blank "auto" value: typing is free; Return
 * or leaving commits — unparsable text goes back to the last value, an out-of-range one is clamped
 * and the field says "Clamped to <v>" for 2.5 s.
 */
export function NumberField({ id, label, help, value, min, max, step, decimals, emptyFor, onChange }: { id: string; label: string; help?: string; value: string; min: number; max: number; step: number; decimals?: number; emptyFor?: number; onChange: (v: string) => void }) {
  const lastGood = useRef(value);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const integer = decimals === undefined;
  const parse = (t: string) => (integer ? parseCount(t) : parseNumber(t));
  const show = (v: number) => (emptyFor !== undefined && v === emptyFor ? "" : integer ? String(v) : decimals! > 0 ? v.toFixed(decimals) : String(v));
  const current = parse(value);
  if ((current !== null && current >= min && current <= max) || (emptyFor !== undefined && value.trim() === "")) lastGood.current = value;

  const commit = () => {
    if (emptyFor !== undefined && value.trim() === "") return;
    const v = parse(value);
    if (v === null) {
      if (value !== lastGood.current) onChange(lastGood.current);
      return;
    }
    const c = Math.min(max, Math.max(min, v));
    const text = c === v ? value : show(c);
    lastGood.current = text;
    if (text !== value) onChange(text);
    if (c !== v) {
      setNotice(w.clampedTo(show(c) || String(c)));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), 2500);
    }
  };
  const stepBy = (d: number) => {
    const base = current ?? emptyFor ?? min;
    const next = Math.min(max, Math.max(min, Math.round((base + d) * 1e9) / 1e9));
    onChange(show(next) || (emptyFor !== undefined ? "" : String(next)));
  };
  return (
    <span className="qn-count" title={help}>
      <input
        id={id}
        className="qn-field qn-field-compact"
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        aria-label={label}
        value={value}
        onChange={(e) => {
          setNotice(null);
          onChange(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <button type="button" className="icon-btn" aria-label={w.decrement(label)} tabIndex={-1} onClick={() => stepBy(-step)}>
        <Icon icon={Minus} size={12} />
      </button>
      <button type="button" className="icon-btn" aria-label={w.increment(label)} tabIndex={-1} onClick={() => stepBy(step)}>
        <Icon icon={Plus} size={12} />
      </button>
      {notice ? (
        <span className="qn-count-notice muted" role="status">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

/** The footer: the Help "?", Set as Default, the first problem, Cancel (Esc) and the confirm button (Return). */
function Footer({ helpTopic, problem, confirmTitle, confirmHelp, blockedHelp, onCancel, onConfirm, leading }: { helpTopic: string; problem: string | null; confirmTitle: string; confirmHelp: string; blockedHelp: string; onCancel: () => void; onConfirm: () => void; leading?: ReactNode }) {
  return (
    <footer className="panel-footer">
      <button type="button" className="icon-btn" aria-label={w.helpButton(topicTitle(helpTopic))} title={w.helpButton(topicTitle(helpTopic))} onClick={() => openHelp(helpTopic)}>
        <Icon icon={CircleHelp} size={16} />
      </button>
      {leading}
      <div className="panel-footer-note">
        {problem ? (
          <span className="qn-sheet-problem" role="status" aria-label={w.cannotContinue(problem)}>
            {problem}
          </span>
        ) : null}
      </div>
      <button type="button" className="btn" title={w.cancelHelp} aria-keyshortcuts="Escape" onClick={onCancel}>
        {w.cancel}
      </button>
      <button type="button" className="btn primary" title={problem ? blockedHelp : confirmHelp} aria-keyshortcuts="Enter" disabled={problem !== null} onClick={onConfirm}>
        {confirmTitle}
      </button>
    </footer>
  );
}

// ── The run-parameter sheet ───────────────────────────────────────────────────────────────────

const GLYPH: Record<SheetSpec["kind"], typeof Play> = {
  "mc-infinite": Activity, "mc-finite": Activity, regenerative: Activity, replicated: Activity, "spectral-infinite": Play, "spectral-finite": Play, "finite-element": Play, multiclass: FlaskConical, lp: TrendingDown, comparison: Play,
};

function FieldControl({ field, uid, form, set }: { field: SheetField; uid: string; form: FormState; set: (k: string, v: string | number | boolean) => void }) {
  const id = `${uid}-${field.key}`;
  const k = field.kind;
  const control = (() => {
    switch (k.type) {
      case "integer":
        if (k.emptyFor === undefined) {
          return <CountField id={id} label={field.title} help={field.help} value={String(form[field.key])} min={k.min} max={k.max} decrementLabel={w.decrement(field.title)} incrementLabel={w.increment(field.title)} onChange={(v) => set(field.key, v)} />;
        }
        return <NumberField id={id} label={field.title} help={field.help} value={String(form[field.key])} min={k.min} max={k.max} step={k.step ?? 1} emptyFor={k.emptyFor} onChange={(v) => set(field.key, v)} />;
      case "decimal":
        return <NumberField id={id} label={field.title} help={field.help} value={String(form[field.key])} min={k.min} max={k.max} step={k.step} decimals={0} onChange={(v) => set(field.key, v)} />;
      case "choice":
        return (
          <select id={id} className="qn-field" aria-label={field.title} title={field.help} value={Number(form[field.key])} onChange={(e) => set(field.key, Number(e.target.value))}>
            {k.options.map((o, i) => (
              <option key={o} value={i}>
                {o}
              </option>
            ))}
          </select>
        );
      case "flag":
        return <input id={id} type="checkbox" role="switch" className="run-ui-switch" aria-label={field.title} title={field.help} checked={Boolean(form[field.key])} onChange={(e) => set(field.key, e.target.checked)} />;
    }
  })();
  return (
    <Row label={field.title} help={field.help ?? field.title} htmlFor={id}>
      {control}
      {field.unit ? <span className="muted run-ui-unit">{field.unit}</span> : null}
      {field.glossary ? <Glossary label={field.title} text={field.glossary} /> : null}
    </Row>
  );
}

function RunParameterPanel({ request }: { request: Extract<PanelRequest, { kind: "run" }> }) {
  const { spec, tabId } = request;
  const uid = useId();
  const [form, setForm] = useState<FormState>(() => initialForm(spec));
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const problem = sheetProblem(spec, form);
  const set = (k: string, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const cancel = () => {
    closePanel();
    addStatus(spec.cancelLine, "warning", tabId);
  };
  const confirm = () => {
    if (sheetProblem(spec, form) !== null) return;
    const values: SheetValues = sheetValues(spec, form);
    closePanel();
    void request.onRun(values);
  };
  const setDefault = spec.defaults
    ? () => {
        if (problem) return;
        setSettings(spec.defaults!(sheetValues(spec, form))).then(
          () => {
            setSaved(true);
            clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSaved(false), 1600);
          },
          (e) => addStatus(w.couldNotSaveDefaults(String(e).replace(/^Error: /, "")), "warning", tabId),
        );
      }
    : null;

  return (
    <PanelWindow id="run-parameters" title={spec.title} band={spec.size} modality="document" onClose={cancel}>
      <div className="panel-form" data-panel="run-parameters" data-sheet={spec.kind} onKeyDown={(e) => onFormKey(e, confirm)}>
        <PanelHeader glyph={<Icon icon={GLYPH[spec.kind]} size={20} className={spec.tint === "warning" ? "run-ui-glyph-warning" : "run-ui-glyph-info"} />} title={spec.title} subtitle={spec.subtitle} />
        <div className="panel-content">
          <form className="run-ui-form" aria-label={spec.title} onSubmit={(e) => e.preventDefault()}>
            {spec.sections.map((s) => (
              <Section key={s.title} title={s.title} footer={s.footer} notice={s.notice}>
                {s.fields.map((f) => (
                  <FieldControl key={f.key} field={f} uid={uid} form={form} set={set} />
                ))}
              </Section>
            ))}
          </form>
        </div>
        <Footer
          helpTopic={spec.helpTopic}
          problem={problem}
          confirmTitle={w.run}
          confirmHelp={spec.confirmHelp}
          blockedHelp={w.blockedHelp}
          onCancel={cancel}
          onConfirm={confirm}
          leading={
            setDefault ? (
              <button type="button" className="btn" title={w.setAsDefaultHelp} aria-label={w.setAsDefaultA11y} disabled={saved || problem !== null} onClick={setDefault}>
                {saved ? w.savedAsDefault : w.setAsDefault}
              </button>
            ) : null
          }
        />
      </div>
    </PanelWindow>
  );
}

/** For tests: the fields a spec shows. */
export const specFieldKeys = (spec: SheetSpec) => allFields(spec).map((f) => f.key);

// ── Test ▸ Run Test Set… ──────────────────────────────────────────────────────────────────────

function RangeFields({ uid, name, label, lower, upper, range, onLower, onUpper, decimals }: { uid: string; name: string; label: string; lower: string; upper: string; range: [number, number]; onLower: (v: string) => void; onUpper: (v: string) => void; decimals?: number }) {
  const field = (which: "lo" | "hi", v: string, on: (v: string) => void) => {
    const fieldLabel = which === "lo" ? w.minimum(label) : w.maximum(label);
    return decimals === undefined ? (
      <CountField id={`${uid}-${name}-${which}`} label={fieldLabel} help={label} value={v} min={range[0]} max={range[1]} decrementLabel={w.decrement(fieldLabel)} incrementLabel={w.increment(fieldLabel)} onChange={on} />
    ) : (
      <NumberField id={`${uid}-${name}-${which}`} label={fieldLabel} help={label} value={v} min={range[0]} max={range[1]} step={0.05} decimals={decimals} onChange={on} />
    );
  };
  return (
    <span className="run-ui-range">
      {field("lo", lower, onLower)}
      <span className="muted" aria-hidden="true">
        …
      </span>
      {field("hi", upper, onUpper)}
    </span>
  );
}

function TopologyRow({ uid, value, onChange }: { uid: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={w.topology} help={w.topologyHelp} htmlFor={`${uid}-topology`}>
      <select id={`${uid}-topology`} className="qn-field" aria-label={w.topology} title={w.topologyHelp} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {w.topologies.map((t, i) => (
          <option key={t} value={i}>
            {t}
          </option>
        ))}
      </select>
    </Row>
  );
}

function SeedRows({ uid, fixed, seed, toggleHelp, seedHelp, seedA11y, onFixed, onSeed }: { uid: string; fixed: boolean; seed: string; toggleHelp: string; seedHelp: string; seedA11y: string; onFixed: (v: boolean) => void; onSeed: (v: string) => void }) {
  return (
    <>
      <Row label={w.fixedSeed} help={toggleHelp} htmlFor={`${uid}-fixed`}>
        <input id={`${uid}-fixed`} type="checkbox" role="switch" className="run-ui-switch" aria-label={w.fixedSeed} title={toggleHelp} checked={fixed} onChange={(e) => onFixed(e.target.checked)} />
      </Row>
      {fixed ? (
        <Row label={w.seed} help={seedHelp} htmlFor={`${uid}-seed`}>
          <CountField id={`${uid}-seed`} label={seedA11y} help={seedHelp} value={seed} min={SEED_RANGE[0]} max={SEED_RANGE[1]} decrementLabel={w.decrement(seedA11y)} incrementLabel={w.increment(seedA11y)} onChange={onSeed} />
        </Row>
      ) : null}
    </>
  );
}

function TestSetPanel({ request }: { request: Extract<PanelRequest, { kind: "test-set" }> }) {
  const { infinite, tabId } = request;
  const uid = useId();
  const [form, setForm] = useState<TestSetForm>(request.form);
  const set = (patch: Partial<TestSetForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = testSetProblem(form);
  const title = w.testSetTitle(infinite);
  const confirm = () => {
    if (testSetProblem(form) !== null) return;
    // The panel goes before the sweep starts (`syncTestSetPanel`).
    closePanel();
    void startSweep(tabId, infinite ? "infinite" : "finite", testSetParams(form));
  };
  return (
    <PanelWindow id="test-set" title={title} band="regular" modality="document" onClose={closePanel}>
      <div className="panel-form" data-panel="test-set" onKeyDown={(e) => onFormKey(e, confirm)}>
        <PanelHeader glyph={<Icon icon={FlaskConical} size={20} className="run-ui-glyph-info" />} title={title} subtitle={w.testSetSubtitle(infinite ? "infinite" : "finite")} />
        <div className="panel-content">
          <form className="run-ui-form" aria-label={title} onSubmit={(e) => e.preventDefault()}>
            <Section title={w.networksSection} footer={w.networksFooter}>
              <Row label={w.stations} help={w.stationsHelp}>
                <RangeFields uid={uid} name="stations" label={w.stations} lower={form.stationsLower} upper={form.stationsUpper} range={STATION_RANGE} onLower={(v) => set({ stationsLower: v })} onUpper={(v) => set({ stationsUpper: v })} />
              </Row>
              <Row label={w.classes} help={w.classesHelp}>
                <RangeFields uid={uid} name="classes" label={w.classes} lower={form.classesLower} upper={form.classesUpper} range={CLASS_RANGE} onLower={(v) => set({ classesLower: v })} onUpper={(v) => set({ classesUpper: v })} />
              </Row>
              <Row label={w.targetRho} help={w.rhoGlossary}>
                <RangeFields uid={uid} name="rho" label={w.targetRhoField} lower={form.rhoLower} upper={form.rhoUpper} range={RHO_RANGE} decimals={2} onLower={(v) => set({ rhoLower: v })} onUpper={(v) => set({ rhoUpper: v })} />
              </Row>
              <TopologyRow uid={uid} value={form.topology} onChange={(topology) => set({ topology })} />
            </Section>
            <Section title={w.sweepSection} footer={testSetSummary(form, infinite)}>
              <Row label={w.testCases} help={w.testCasesHelp} htmlFor={`${uid}-cases`}>
                <CountField id={`${uid}-cases`} label={w.testCases} help={w.testCases} value={form.numCases} min={TEST_CASES[0]} max={TEST_CASES[1]} decrementLabel={w.decrement(w.testCases)} incrementLabel={w.increment(w.testCases)} onChange={(numCases) => set({ numCases })} />
              </Row>
              <SeedRows uid={uid} fixed={form.fixedSeed} seed={form.seed} toggleHelp={w.fixedSeedHelp} seedHelp={w.seedHelp} seedA11y={w.seedA11y} onFixed={(fixedSeed) => set({ fixedSeed })} onSeed={(seed) => set({ seed })} />
            </Section>
          </form>
        </div>
        <Footer helpTopic="testSets" problem={problem} confirmTitle={w.run} confirmHelp={w.testConfirmHelp} blockedHelp={w.testBlockedHelp} onCancel={closePanel} onConfirm={confirm} />
      </div>
    </PanelWindow>
  );
}

// ── Test ▸ Run Infinite Spectral Convergence… ─────────────────────────────────────────────────

function SpectralConvergencePanel({ request }: { request: Extract<PanelRequest, { kind: "spectral-convergence" }> }) {
  const uid = useId();
  const [form, setForm] = useState<SpectralConvergenceForm>(request.form);
  const set = (patch: Partial<SpectralConvergenceForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = spectralConvergenceProblem(form);
  const [s, e, st] = [parseNumber(form.rhoStart) ?? NaN, parseNumber(form.rhoEnd) ?? NaN, parseNumber(form.rhoStep) ?? NaN];
  const stepInvalid = !(st > 0 && st <= e - s + 1e-9);
  const confirm = () => {
    if (spectralConvergenceProblem(form) !== null) return;
    closePanel();
    void startSweep(request.tabId, "spc", spectralConvergenceParams(form));
  };
  return (
    <PanelWindow id="spectral-convergence" title={w.spcTitle} band="tall" modality="document" onClose={closePanel}>
      <div className="panel-form" data-panel="spectral-convergence" onKeyDown={(ev) => onFormKey(ev, confirm)}>
        <PanelHeader glyph={<Icon icon={TrendingDown} size={20} className="run-ui-glyph-info" />} title={w.spcTitle} subtitle={w.spcSubtitle} />
        <div className="panel-content">
          <form className="run-ui-form" aria-label={w.spcTitle} onSubmit={(ev) => ev.preventDefault()}>
            <Section title={w.networksSection}>
              <Row label={w.stations} help={w.stationsHelp}>
                <RangeFields uid={uid} name="stations" label={w.stations} lower={form.stationsLower} upper={form.stationsUpper} range={STATION_RANGE} onLower={(v) => set({ stationsLower: v })} onUpper={(v) => set({ stationsUpper: v })} />
              </Row>
              <Row label={w.classes} help={w.classesHelp}>
                <RangeFields uid={uid} name="classes" label={w.classes} lower={form.classesLower} upper={form.classesUpper} range={CLASS_RANGE} onLower={(v) => set({ classesLower: v })} onUpper={(v) => set({ classesUpper: v })} />
              </Row>
              <TopologyRow uid={uid} value={form.topology} onChange={(topology) => set({ topology })} />
            </Section>
            <Section title={w.sweepSection} footer={spectralConvergenceSummary(form)}>
              <Row label={w.rhoSweep} help={w.rhoSweepHelp}>
                <span className="run-ui-range">
                  <NumberField id={`${uid}-start`} label={w.sweepStart} help={w.sweepStart} value={form.rhoStart} min={RHO_RANGE[0]} max={RHO_RANGE[1]} step={0.05} decimals={2} onChange={(rhoStart) => set({ rhoStart })} />
                  <span className="muted" aria-hidden="true">
                    →
                  </span>
                  <NumberField id={`${uid}-end`} label={w.sweepEnd} help={w.sweepEnd} value={form.rhoEnd} min={RHO_RANGE[0]} max={RHO_RANGE[1]} step={0.05} decimals={2} onChange={(rhoEnd) => set({ rhoEnd })} />
                </span>
              </Row>
              <Row label={w.step} help={w.stepHelp} htmlFor={`${uid}-step`}>
                <span className="qn-field-stack">
                  <NumberField id={`${uid}-step`} label={w.sweepStep} help={w.sweepStep} value={form.rhoStep} min={-Infinity} max={Infinity} step={0.01} decimals={2} onChange={(rhoStep) => set({ rhoStep })} />
                  {stepInvalid ? <span className="qn-field-error">{w.stepError}</span> : null}
                </span>
              </Row>
              <Row label={w.testCases} help={w.spcCasesHelp} htmlFor={`${uid}-cases`}>
                <CountField id={`${uid}-cases`} label={w.testCases} help={w.testCases} value={form.numCases} min={SPC_CASES[0]} max={SPC_CASES[1]} decrementLabel={w.decrement(w.testCases)} incrementLabel={w.increment(w.testCases)} onChange={(numCases) => set({ numCases })} />
              </Row>
              <SeedRows uid={uid} fixed={form.fixedSeed} seed={form.seed} toggleHelp={w.spcFixedSeedHelp} seedHelp={w.spcSeedHelp} seedA11y={w.spcSeedA11y} onFixed={(fixedSeed) => set({ fixedSeed })} onSeed={(seed) => set({ seed })} />
            </Section>
          </form>
        </div>
        <Footer helpTopic="testSets" problem={problem} confirmTitle={w.run} confirmHelp={w.spcConfirmHelp} blockedHelp={w.testBlockedHelp} onCancel={closePanel} onConfirm={confirm} />
      </div>
    </PanelWindow>
  );
}

