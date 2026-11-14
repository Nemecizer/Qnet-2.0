// The inspector's field components (0.90.34 DSFields.swift, DSControls.swift: DSInspectorRow,
// DSNumericField, DSTextField, DSSegmentedPicker, DSMenuPicker, InlineFieldMessage,
// DSGlossaryButton; ledger INS-131…147). Every row keeps a message slot so a validation caption never
// changes the form's height; numeric fields are right-aligned with monospaced digits; a field that
// holds a legal prefix of a number while it has focus shows no red at all.
import { useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronUp, CircleAlert, Ellipsis } from "lucide-react";
import { stationPicture } from "../../editor/pictures";
import { Icon } from "../../components/Icon";
import { classLabel } from "../../editor";
import { groupedInt, isPartialNumber, parseNumber, fieldText, formatSig, tidied } from "./distributions";
import { inspectorWords as w } from "./words";

export type Severity = "error" | "warning" | "pending";

/** InlineFieldMessage: error red with a filled circle, warning a triangle, pending a calm ellipsis. */
export function InlineMessage({ message, severity = "error", lines, title }: { message: string | null | undefined; severity?: Severity; lines?: number; title?: string }) {
  if (!message) return <div className="insp-msg insp-msg-empty" aria-hidden="true" />;
  const glyph = severity === "error" ? CircleAlert : severity === "warning" ? AlertTriangle : Ellipsis;
  const prefix = severity === "error" ? w.errorPrefix : severity === "warning" ? w.warningPrefix : w.pendingPrefix;
  const max = lines ?? (severity === "pending" ? 1 : 3);
  return (
    <div className={`insp-msg insp-msg-${severity}`} role={severity === "error" ? "alert" : "status"} title={title ?? (severity === "pending" ? w.pendingHelp : undefined)} style={{ WebkitLineClamp: max }}>
      <Icon icon={glyph} size={12} />
      <span className="insp-vh">{prefix} </span>
      <span className="insp-msg-text">{message}</span>
    </div>
  );
}

/** DSGlossaryButton: a "?" that opens a popover with the plain-language definition. */
export function GlossaryButton({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="insp-glossary">
      <button type="button" className="insp-glossary-btn" aria-label={w.glossaryButton(label)} title={w.glossaryButton(label)} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open ? (
        <span
          id={id}
          role="dialog"
          aria-label={label}
          className="insp-glossary-pop"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** DSInspectorRow: label (with glossary), the control, and a reserved message slot beneath. */
export function Row({ label, glossary, help, error, warning, dimmed, children, labelFor, className }: { label: string; glossary?: string; help?: string; error?: string | null; warning?: string | null; dimmed?: boolean; children: ReactNode; labelFor?: string; className?: string }) {
  return (
    <div className={`insp-row${dimmed ? " is-dimmed" : ""}${className ? " " + className : ""}`} title={help}>
      <div className="insp-row-label">
        {labelFor ? <label htmlFor={labelFor}>{label}</label> : <span>{label}</span>}
        {glossary ? <GlossaryButton label={label} text={glossary} /> : null}
      </div>
      <div className="insp-row-control">{children}</div>
      <div className="insp-row-msg">{error ? <InlineMessage message={error} severity="error" /> : warning ? <InlineMessage message={warning} severity="warning" /> : <InlineMessage message={null} />}</div>
    </div>
  );
}

export type FieldWidth = "compact" | "narrow" | "field" | "wide" | "fill";

export interface NumericFieldProps {
  label: string;
  value: string;
  onChange: (text: string) => void;
  unit?: string | null;
  /** The range the caption states ("Must be between 1 and 10,000"); the text is never clamped. */
  range?: [number, number];
  /** Linear step; the stepper starts from the typed value (or 0) and clamps into `range`. */
  step?: number;
  /** The caller's message (it takes precedence over the field's own range caption). */
  error?: string | null;
  help?: string;
  glossary?: string;
  placeholder?: string;
  width?: FieldWidth;
  ariaLabel?: string;
  disabled?: boolean;
  /** Integer field: "Enter a whole number" and grouped bounds. */
  integer?: boolean;
  /** The row's own layout off: just the field (the per-class table's cells). */
  bare?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
  onFocusChange?: (focused: boolean) => void;
  /** Return (onSubmit). */
  onSubmit?: () => void;
  autoFocus?: boolean;
  dataField?: string;
}

/** DSNumericField over text (`.text` store): strict validation, the text is the caller's. */
export function NumericField(p: NumericFieldProps) {
  const [focused, setFocused] = useState(false);
  const id = useId();
  const raw = p.value.replace(/^[ \t]+|[ \t]+$/g, "");
  let own: string | null = null;
  if (raw) {
    const v = parseNumber(raw);
    if (v === null) own = p.integer ? w.enterWhole : w.enterNumber;
    else if (p.range && (v < p.range[0] || v > p.range[1])) {
      const f = p.integer ? groupedInt : (x: number) => formatSig(x);
      own = w.between(f(p.range[0]), f(p.range[1]), p.unit ?? null);
    }
  }
  const midNumber = focused && isPartialNumber(p.value);
  const shown = p.disabled || midNumber ? null : (p.error ?? own);
  const stepBy = (dir: 1 | -1) => {
    if (!p.step) return;
    const base = parseNumber(p.value) ?? 0;
    let v = tidied(base + p.step * dir);
    if (p.range) v = Math.min(Math.max(v, p.range[0]), p.range[1]);
    p.onChange(fieldText(v));
  };
  const canStep = (() => {
    if (!p.step) return false;
    const base = parseNumber(p.value) ?? 0;
    const clamp = (x: number) => (p.range ? Math.min(Math.max(x, p.range[0]), p.range[1]) : x);
    return clamp(base + p.step) !== base || clamp(base - p.step) !== base;
  })();
  const field = (
    <span className="insp-field-line">
      <input
        id={id}
        ref={p.inputRef}
        type="text"
        inputMode="decimal"
        className={`insp-input insp-number w-${p.width ?? "field"}${shown ? " is-invalid" : ""}`}
        value={p.value}
        placeholder={p.placeholder}
        aria-label={p.ariaLabel ?? p.label}
        aria-invalid={shown ? true : undefined}
        title={p.help ?? p.label}
        disabled={p.disabled}
        autoFocus={p.autoFocus}
        spellCheck={false}
        autoComplete="off"
        data-inspector-field={p.dataField ?? ""}
        onChange={(e) => p.onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          p.onFocusChange?.(true);
        }}
        onBlur={() => {
          setFocused(false);
          p.onFocusChange?.(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) p.onSubmit?.();
        }}
      />
      {p.step ? (
        <span className="insp-stepper" role="group" aria-label={w.stepper(p.ariaLabel ?? p.label)}>
          <button type="button" tabIndex={-1} aria-label={w.increment} disabled={p.disabled || !canStep} onClick={() => stepBy(1)} onMouseDown={(e) => e.preventDefault()}>
            <Icon icon={ChevronUp} size={12} />
          </button>
          <button type="button" tabIndex={-1} aria-label={w.decrement} disabled={p.disabled || !canStep} onClick={() => stepBy(-1)} onMouseDown={(e) => e.preventDefault()}>
            <Icon icon={ChevronDown} size={12} />
          </button>
        </span>
      ) : null}
      {p.bare ? null : <span className={`insp-unit${p.disabled ? " is-dimmed" : ""}`}>{p.unit ?? ""}</span>}
    </span>
  );
  if (p.bare) return field;
  return (
    <Row label={p.label} glossary={p.glossary} error={shown} dimmed={p.disabled} labelFor={id}>
      {field}
    </Row>
  );
}

/** DSTextField: `required` keeps a focused, emptied field calm (no red until it is left). */
export function TextField(p: { label: string; value: string; onChange: (t: string) => void; placeholder?: string; help?: string; error?: string | null; required?: boolean; width?: FieldWidth; inputRef?: (el: HTMLInputElement | null) => void; onFocusChange?: (f: boolean) => void; onSubmit?: () => void; autoFocus?: boolean }) {
  const [focused, setFocused] = useState(false);
  const id = useId();
  const calm = p.required && focused && !p.value.trim();
  const shown = calm ? null : (p.error ?? null);
  return (
    <Row label={p.label} error={shown} labelFor={id}>
      <input
        id={id}
        ref={p.inputRef}
        type="text"
        className={`insp-input w-${p.width ?? "wide"}${shown ? " is-invalid" : ""}`}
        value={p.value}
        placeholder={p.placeholder}
        title={p.help}
        aria-invalid={shown ? true : undefined}
        aria-required={p.required || undefined}
        autoFocus={p.autoFocus}
        spellCheck={false}
        autoComplete="off"
        data-inspector-field="name"
        onChange={(e) => p.onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          p.onFocusChange?.(true);
        }}
        onBlur={() => {
          setFocused(false);
          p.onFocusChange?.(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) p.onSubmit?.();
        }}
      />
    </Row>
  );
}

/** DSSegmentedPicker: a row of radio buttons. */
export function Segmented<T extends string | boolean>({ label, value, options, render, onChange, help, glossary, disabled }: { label: string; value: T; options: readonly T[]; render: (v: T) => string; onChange: (v: T) => void; help?: string; glossary?: string; disabled?: boolean }) {
  return (
    <Row label={label} glossary={glossary} help={help}>
      <span className="insp-segmented" role="radiogroup" aria-label={label} title={help}>
        {options.map((o) => (
          <button
            key={String(o)}
            type="button"
            role="radio"
            aria-checked={o === value}
            className={o === value ? "is-on" : undefined}
            disabled={disabled}
            onClick={() => o !== value && onChange(o)}
          >
            {render(o)}
          </button>
        ))}
      </span>
    </Row>
  );
}

export interface MenuOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** DSMenuPicker as the platform's own pop-up menu (a <select>). */
export function MenuPicker<T extends string | number>({ label, value, options, onChange, help, glossary, ariaLabel, bare, width, disabled }: { label: string; value: T; options: readonly MenuOption<T>[]; onChange: (v: T) => void; help?: string; glossary?: string; ariaLabel?: string; bare?: boolean; width?: FieldWidth; disabled?: boolean }) {
  const id = useId();
  const select = (
    <select
      id={id}
      className={`insp-select w-${width ?? "field"}`}
      value={String(value)}
      aria-label={ariaLabel ?? label}
      title={help}
      disabled={disabled}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (bare) return select;
  return (
    <Row label={label} glossary={glossary} help={help} labelFor={id}>
      {select}
    </Row>
  );
}

// ── Classes ──────────────────────────────────────────────────────────────────────────────────

const HSV = (h: number, s: number, v: number) => {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(5))}${hex(f(3))}${hex(f(1))}`;
};

/**
 * A class's colour (MODEL-010): classes 0–7 are the canvas's class tokens (--canvas-class-1…--canvas-class-8,
 * the system red, blue, green, orange, purple, cyan, pink, yellow); from class 8 on the hue walks
 * the golden angle, saturation 0.72 / 0.88 by parity, brightness 0.82 every third, else 0.95.
 */
export function classColor(i: number): string {
  if (i < 8) return `var(--canvas-class-${i + 1})`;
  const overflow = i - 8;
  const hue = overflow * 0.61803398875;
  return HSV(hue - Math.floor(hue), overflow % 2 === 0 ? 0.72 : 0.88, overflow % 3 === 0 ? 0.82 : 0.95);
}

/** ClassChip: the class's colour dot and "Class N" (compact: "C N"). */
export function ClassChip({ index, compact }: { index: number; compact?: boolean }) {
  return (
    <span className={`insp-chip${compact ? " is-compact" : ""}`} style={{ ["--chip" as string]: classColor(index) }}>
      <span className="insp-chip-dot" aria-hidden="true" />
      {compact ? `C${index + 1}` : classLabel(index)}
    </span>
  );
}

/** The "→ C2" exit-class tag (INS-123). */
export function ExitClassTag({ exitClass }: { exitClass: number }) {
  return (
    <span className="insp-exit-tag">
      <span aria-hidden="true">→</span>
      <ClassChip index={exitClass} compact />
    </span>
  );
}

/** Keeps a callback's latest version for event handlers registered once. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** The station fill circle with the picture inset by 18 % of its size; "No Picture" draws a blocked sign. */
export function PicturePreview({ sf, size, selected }: { sf: string; size: number; selected?: boolean }) {
  const p = stationPicture(sf);
  const inset = Math.round(size * 0.18);
  const glyph = p.icon ?? Ban;
  return (
    <span className={`insp-picture${selected ? " is-selected" : ""}${p.icon ? "" : " is-none"}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon icon={glyph} size={16} style={{ width: size - 2 * inset, height: size - 2 * inset }} />
    </span>
  );
}

