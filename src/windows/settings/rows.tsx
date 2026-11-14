// The Settings window's row kinds (0.90.34 SettingsComponents.swift: SettingsToggleRow,
// SettingsMenuRow, SettingsNumberRow, SettingsRangeRow, SettingsSliderRow, SettingsFontFamilyRow,
// with DSFields.swift's DSNumericField and DSRangeFields): a label with its caption and tooltip,
// the control, the reserved "?" glossary slot, and the row's inline message. Every control applies
// at once through `setSettings` (ledger SET-030); a value Rust refuses shows Rust's sentence under
// the row. A number field validates as it is typed, commits on Return, focus loss or its stepper,
// and clamps into its range (SET-035).
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, CircleHelp, TriangleAlert } from "lucide-react";
import { Icon } from "../../components/Icon";
import type { KvValues, SettingSchemaKey } from "../../lib/types";
import { entry, entryMatches } from "./registry";
import { glossary, rows, settingsWords, type RowWords } from "./words";

const fw = settingsWords.field;

/** What every row reads: the values, the schema, the writer, and the search and flash state. */
export interface SettingsContext {
  values: KvValues;
  schema: Map<string, SettingSchemaKey>;
  /** Applies a patch; resolves to null, or to Rust's sentence when it refused. */
  set: (patch: KvValues) => Promise<string | null>;
  query: string;
  /** The row a search jump landed on, with a token that re-fires the flash. */
  jump: { id: string; token: number } | null;
  /** Rows a Reset to Defaults changed. */
  flash: { ids: Set<string>; token: number } | null;
  /** The station count of the front network, or null with none open (ledger SET-179). */
  dimension: number | null;
  /** The document the window renders into (alerts and popovers go there). */
  doc: Document;
  openPane: (pane: string) => void;
}

export const Ctx = createContext<SettingsContext | null>(null);

export function useSettingsCtx(): SettingsContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("Settings rows need the Settings context");
  return c;
}

/** The words of a row (words.ts), or a bare label. */
export function w(id: string): RowWords {
  return rows[id] ?? { label: id };
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A double with `min`…`max` fraction digits, grouped (`.number.precision(.fractionLength(a...b))`). */
export function fmt(v: number, digits: [number, number]): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: digits[0], maximumFractionDigits: digits[1] });
}

/** Parses a typed number (grouping allowed); null when it isn't one. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The "?" slot every row ends with: a glossary popover where the row has an entry. */
function GlossarySlot({ label, text }: { label: string; text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="set-glossary-slot" aria-hidden="true" />;
  return (
    <span className="set-glossary-slot">
      <button type="button" className="set-icon-btn" aria-label={fw.glossary(label)} aria-expanded={open} title={text} onClick={() => setOpen(!open)}>
        <Icon icon={CircleHelp} size={14} />
      </button>
      {open && (
        <span className="set-popover" role="note" onClick={() => setOpen(false)}>
          {text}
        </span>
      )}
    </span>
  );
}

/** A row's anchor (SettingsAnchorModifier): a search jump scrolls it to the centre and flashes it,
 * a Reset flashes it when its value changed, and it keeps a faint tint while the query matches it. */
export function useAnchor(id: string) {
  const c = useSettingsCtx();
  const ref = useRef<HTMLDivElement>(null);
  const [glow, setGlow] = useState(false);
  const e = entry(id);
  const isMatch = !!e && !!c.query.trim() && entryMatches(e, c.query);
  useEffect(() => {
    if (c.jump?.id !== id) return;
    // An explicit "smooth" is not stopped by the stylesheet's `scroll-behavior: auto`: Reduce Motion is asked here.
    const root = ref.current?.ownerDocument.documentElement;
    const motion = root?.getAttribute("data-motion");
    const still = motion ? motion === "reduce" : (ref.current?.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    ref.current?.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    setGlow(true);
    const t = setTimeout(() => setGlow(false), 750);
    return () => clearTimeout(t);
  }, [c.jump?.token]);
  useEffect(() => {
    if (!c.flash?.ids.has(id)) return;
    setGlow(true);
    const t = setTimeout(() => setGlow(false), 450);
    return () => clearTimeout(t);
  }, [c.flash?.token]);
  return { ref, cls: `${isMatch ? " match" : ""}${glow ? " glow" : ""}` };
}

/** A row: label and caption on the left, the control and "?" on the right, messages under it. */
export function Row({
  id,
  words,
  caption,
  control,
  disabled,
  messages,
  dimLabel,
}: {
  id: string;
  words?: RowWords;
  caption?: string;
  control: ReactNode;
  disabled?: boolean;
  messages?: { text: string; severity: "error" | "warning" }[];
  dimLabel?: boolean;
}) {
  const rw = words ?? w(id);
  const { ref, cls } = useAnchor(id);
  const cap = caption ?? rw.caption;
  return (
    <div
      ref={ref}
      className={`set-row${cls}${disabled ? " disabled" : ""}`}
      data-anchor={id}
    >
      <div className={`set-label${dimLabel ? " dim" : ""}`} title={rw.help}>
        <span className="set-title">{rw.label}</span>
        {cap && <span className="set-caption">{cap}</span>}
      </div>
      <div className="set-control">
        {control}
        <GlossarySlot label={rw.label} text={rw.glossary ? glossary[rw.glossary] : undefined} />
      </div>
      {messages?.map((m) => (
        <div key={m.text} className={`set-message ${m.severity}`} role={m.severity === "error" ? "alert" : "status"}>
          {m.severity === "warning" && <Icon icon={TriangleAlert} size={12} />}
          {m.text}
        </div>
      ))}
    </div>
  );
}

/** Runs a write and keeps Rust's refusal for the row to show. */
function useWriter() {
  const c = useSettingsCtx();
  const [refusal, setRefusal] = useState<string | null>(null);
  const write = async (patch: KvValues) => setRefusal(await c.set(patch));
  return { refusal, write, c };
}

const refusalMessages = (r: string | null) => (r ? [{ text: r, severity: "error" as const }] : []);

export function ToggleRow({ id, k, disabled, caption }: { id: string; k?: string; disabled?: boolean; caption?: string }) {
  const { refusal, write, c } = useWriter();
  const key = k ?? id;
  const rw = w(id);
  return (
    <Row
      id={id}
      caption={caption}
      disabled={disabled}
      messages={refusalMessages(refusal)}
      control={
        <input
          type="checkbox"
          role="switch"
          className="set-switch"
          aria-label={rw.label}
          title={rw.help}
          disabled={disabled}
          checked={c.values[key] === true}
          onChange={(e) => void write({ [key]: e.target.checked })}
        />
      }
    />
  );
}

/** A pop-up of options; the caption under the label describes the selected one (SET-037). */
export function MenuRow<T extends number | string>({
  id,
  k,
  options,
  titles,
  details,
  disabled,
}: {
  id: string;
  k?: string;
  options: readonly T[];
  titles?: (v: T, i: number) => string;
  details?: (v: T, i: number) => string;
  disabled?: boolean;
}) {
  const { refusal, write, c } = useWriter();
  const key = k ?? id;
  const rw = w(id);
  const value = c.values[key] as T;
  const index = Math.max(0, options.findIndex((o) => (typeof o === "number" ? Math.abs((o as number) - num(value, NaN)) <= 1e-9 : o === value)));
  const title = (o: T, i: number) => titles?.(o, i) ?? rw.titles?.[i] ?? String(o);
  const detail = details?.(options[index], index) ?? rw.details?.[index];
  return (
    <Row
      id={id}
      caption={detail}
      disabled={disabled}
      messages={refusalMessages(refusal)}
      control={
        <select
          className="set-select"
          aria-label={rw.label}
          title={rw.help}
          disabled={disabled}
          value={String(index)}
          onChange={(e) => void write({ [key]: options[Number(e.target.value)] })}
        >
          {options.map((o, i) => (
            <option key={String(o)} value={String(i)}>
              {title(o, i)}
            </option>
          ))}
        </select>
      }
    />
  );
}

export interface NumberSpec {
  /** The stored key. */
  k: string;
  int: boolean;
  /** Field range; the key's schema range when left out. */
  range?: [number, number];
  step?: number;
  /** The stepper multiplies and divides by `step` (ε). */
  log?: boolean;
  /** Fraction digits shown for a double (default 0…4). */
  digits?: [number, number];
  /** A stored 0 shows as an empty field whose placeholder names the automatic value. */
  zeroMeansAuto?: boolean;
  placeholder?: string;
  unit?: string;
  label: string;
}

/** DSNumericField: the text, its live check, and its commit. */
export function NumberField({ spec, disabled, onRefusal, ariaLabel }: { spec: NumberSpec; disabled?: boolean; onRefusal?: (r: string | null) => void; ariaLabel?: string }) {
  const c = useSettingsCtx();
  const range = spec.range ?? c.schema.get(spec.k)?.range ?? null;
  const digits = spec.digits ?? [0, 4];
  const stored = num(c.values[spec.k]);
  const show = (v: number) => (spec.zeroMeansAuto && v === 0 ? "" : spec.int ? v.toLocaleString("en-US") : fmt(v, digits));
  const [text, setText] = useState(show(stored));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(show(stored));
  }, [stored, editing]);
  const bound = (v: number) => (spec.int ? v.toLocaleString("en-US") : fmt(v, digits));
  const check = (t: string): string | null => {
    const raw = t.trim();
    if (!raw) return spec.zeroMeansAuto ? null : spec.int ? fw.enterWhole : fw.enterNumber;
    const v = parseNumber(raw);
    if (v === null || (spec.int && !Number.isInteger(v))) return spec.int ? fw.enterWhole : fw.enterNumber;
    if (range && (v < range[0] || v > range[1])) return fw.between(bound(range[0]), bound(range[1]), spec.unit);
    return null;
  };
  const error = editing ? check(text) : null;
  const clamp = (v: number) => (range ? Math.min(range[1], Math.max(range[0], v)) : v);
  const commitValue = async (v: number) => {
    const next = spec.zeroMeansAuto && v === 0 ? 0 : spec.int ? Math.round(clamp(v)) : Math.round(clamp(v) * 1e9) / 1e9;
    setText(show(next));
    if (next !== stored) onRefusal?.(await c.set({ [spec.k]: next }));
  };
  const commit = () => {
    setEditing(false);
    const raw = text.trim();
    if (!raw && spec.zeroMeansAuto) return void commitValue(0);
    const v = parseNumber(raw);
    if (v === null) return setText(show(stored));
    void commitValue(v);
  };
  const stepBy = (dir: 1 | -1) => {
    const base = parseNumber(text) ?? stored;
    const s = spec.step ?? 1;
    void commitValue(spec.log ? (dir > 0 ? base * s : base / s) : base + dir * s);
    setEditing(false);
  };
  return (
    <span className="set-number">
      <input
        type="text"
        inputMode="decimal"
        className={`set-field${error ? " invalid" : ""}`}
        aria-label={ariaLabel ?? spec.label}
        aria-invalid={!!error}
        disabled={disabled}
        placeholder={spec.placeholder}
        value={text}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(e.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      <span className="set-stepper">
        <button type="button" className="set-step" tabIndex={-1} aria-label={`${fw.stepUp} ${spec.label}`} disabled={disabled} onClick={() => stepBy(1)}>
          <Icon icon={ChevronUp} size={12} />
        </button>
        <button type="button" className="set-step" tabIndex={-1} aria-label={`${fw.stepDown} ${spec.label}`} disabled={disabled} onClick={() => stepBy(-1)}>
          <Icon icon={ChevronDown} size={12} />
        </button>
      </span>
      <span className="set-unit">{spec.unit ?? ""}</span>
      {error && (
        <span className="set-field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** SettingsNumberRow: a number field, optionally behind an override switch (`toggle`). */
export function NumberRow({
  id,
  k,
  int,
  caption,
  disabled,
  toggle,
  crossCheck,
  warning,
  ...rest
}: Omit<NumberSpec, "k" | "label" | "unit"> & { id: string; k?: string; caption?: string; disabled?: boolean; toggle?: string; crossCheck?: string | null; warning?: string | null }) {
  const c = useSettingsCtx();
  const rw = w(id);
  const key = k ?? id;
  const [refusal, setRefusal] = useState<string | null>(null);
  const on = toggle ? c.values[toggle] === true : true;
  const messages: { text: string; severity: "error" | "warning" }[] = [...refusalMessages(refusal)];
  if (crossCheck) messages.push({ text: crossCheck, severity: "error" });
  if (warning) messages.push({ text: warning, severity: "warning" });
  return (
    <Row
      id={id}
      caption={caption}
      disabled={disabled}
      dimLabel={!on}
      messages={messages}
      control={
        <>
          {toggle && (
            <input
              type="checkbox"
              role="switch"
              className="set-switch"
              aria-label={fw.override(rw.label)}
              disabled={disabled}
              checked={on}
              onChange={async (e) => setRefusal(await c.set({ [toggle]: e.target.checked }))}
            />
          )}
          <NumberField spec={{ ...rest, k: key, int, unit: rw.unit, label: rw.label }} disabled={disabled || !on} onRefusal={setRefusal} />
        </>
      }
    />
  );
}

/** SettingsRangeRow: lo … hi with a live order check (strict: lo < hi). */
export function RangeRow({ id, lo, hi, int, step, digits, strict }: { id: string; lo: string; hi: string; int: boolean; step?: number; digits?: [number, number]; strict?: boolean }) {
  const c = useSettingsCtx();
  const rw = w(id);
  const [refusal, setRefusal] = useState<string | null>(null);
  const a = num(c.values[lo]);
  const b = num(c.values[hi]);
  const order = (strict ? a >= b : a > b) ? (strict ? fw.orderStrict : fw.order) : null;
  const d = digits ?? [2, 2];
  return (
    <Row
      id={id}
      messages={[...refusalMessages(refusal), ...(order ? [{ text: order, severity: "error" as const }] : [])]}
      control={
        <span className="set-range">
          <NumberField spec={{ k: lo, int, step, digits: d, label: rw.label }} ariaLabel={`${rw.label} minimum`} onRefusal={setRefusal} />
          <span className="set-range-sep">…</span>
          <NumberField spec={{ k: hi, int, step, digits: d, label: rw.label }} ariaLabel={`${rw.label} maximum`} onRefusal={setRefusal} />
        </span>
      }
    />
  );
}

/** SettingsSliderRow: a slider with a fixed-width readout. */
export function SliderRow({ id, k, step, digits }: { id: string; k?: string; step: number; digits: [number, number] }) {
  const { refusal, write, c } = useWriter();
  const key = k ?? id;
  const rw = w(id);
  const range = c.schema.get(key)?.range ?? [0, 1];
  const v = num(c.values[key]);
  return (
    <Row
      id={id}
      messages={refusalMessages(refusal)}
      control={
        <span className="set-slider">
          <input
            type="range"
            aria-label={rw.label}
            title={rw.help}
            min={range[0]}
            max={range[1]}
            step={step}
            value={v}
            onChange={(e) => void write({ [key]: Number(e.target.value) })}
          />
          <span className="set-readout">{fmt(v, digits)}</span>
          <span className="set-unit">{rw.unit ?? ""}</span>
        </span>
      }
    />
  );
}

/** Fixed-pitch families macOS ships. A web view can't list installed families (ledger SET-141). */
export const MONOSPACE_FAMILIES = ["Andale Mono", "Courier", "Courier New", "Menlo", "Monaco", "PT Mono", "SF Mono"];
const PROPORTIONAL_FAMILIES = ["Arial", "Avenir", "Avenir Next", "Futura", "Geneva", "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Lucida Grande", "Optima", "Palatino", "Times New Roman", "Verdana"];

/** SettingsFontFamilyRow: "System Monospaced (default)", then the families; a sample under it. */
export function FontRow({ id, proportional }: { id: string; proportional: boolean }) {
  const { refusal, write, c } = useWriter();
  const rw = w(id);
  const value = typeof c.values[id] === "string" ? (c.values[id] as string) : "";
  const [showAll, setShowAll] = useState(proportional && !!value && !MONOSPACE_FAMILIES.includes(value));
  const showId = useId();
  let list = showAll && proportional ? [...MONOSPACE_FAMILIES, ...PROPORTIONAL_FAMILIES].sort() : MONOSPACE_FAMILIES;
  if (value && !list.includes(value)) list = [value, ...list];
  return (
    <Row
      id={id}
      messages={refusalMessages(refusal)}
      control={
        <span className="set-font">
          <select className="set-select wide" aria-label={rw.label} title={rw.help} value={value} onChange={(e) => void write({ [id]: e.target.value })}>
            <option value="">{fw.systemMono}</option>
            {list.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <span className="set-font-sample" title={fw.previewOf(value)} aria-hidden="true" style={{ fontFamily: value ? `"${value}", var(--mono)` : "var(--mono)" }}>
            {fw.fontSample}
          </span>
          {proportional && (
            <label className="set-show-all" htmlFor={showId} title={fw.showAllFontsTip}>
              <input id={showId} type="checkbox" role="switch" className="set-switch mini" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {fw.showAllFonts}
            </label>
          )}
        </span>
      }
    />
  );
}

/** A text field that commits on Return or focus loss (Base URL, Model). */
export function TextField({ k, label, placeholder, after }: { k: string; label: string; placeholder?: string; after?: ReactNode }) {
  const c = useSettingsCtx();
  const stored = typeof c.values[k] === "string" ? (c.values[k] as string) : "";
  const [text, setText] = useState(stored);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => setText(stored), [stored, k]);
  const commit = async () => {
    if (text !== stored) setRefusal(await c.set({ [k]: text }));
  };
  return (
    <span className="set-text">
      <input
        type="text"
        className="set-field wide mono"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && void commit()}
      />
      {after}
      {refusal && (
        <span className="set-field-error" role="alert">
          {refusal}
        </span>
      )}
    </span>
  );
}

/** A small menu behind an icon button (the Base URL and Model rows' lists). */
export function IconMenu({ label, help, icon, sections, onPick }: { label: string; help: string; icon: ReactNode; sections: { title?: string; items: { label: string; value: string }[] }[]; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="set-menu-wrap">
      <button type="button" className="set-icon-btn" aria-label={label} title={help} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
      </button>
      {open && (
        <span className="set-menu" role="menu">
          {sections.map((s, i) => (
            <span key={i} className="set-menu-section">
              {s.title && <span className="set-menu-title">{s.title}</span>}
              {s.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  className="set-menu-item"
                  onClick={() => {
                    setOpen(false);
                    onPick(it.value);
                  }}
                >
                  {it.label}
                </button>
              ))}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Section footer text (SettingsFootnote). */
export function Footnote({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <p className={`set-footnote${warning ? " warning" : ""}`}>
      {warning && <Icon icon={TriangleAlert} size={12} />}
      {children}
    </p>
  );
}

/** A grouped section with its header and footer. */
export function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section" aria-label={title}>
      <h3 className="set-section-title">{title}</h3>
      <div className="set-group">{children}</div>
      {footer}
    </section>
  );
}
