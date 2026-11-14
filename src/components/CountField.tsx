// A value-backed whole-number field with a stepper (0.90.34 DSFields.swift `DSNumericField` over an
// Int store, ledger INS-138, INS-141): what the Generate Random sheet and the archetype gallery use.
// Typing is free; Return or leaving the field commits: unparsable text goes back to the last value,
// an out-of-range one is clamped into the range and the field says "Clamped to <v>" for 2.5 s or
// until the next keystroke. "1e3" counts as 1000 when it is whole and below 9e15.
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { parseNumber, parseWhole } from "../workspace/files/generate";
import { words } from "../lib/vocabulary";

/** DSNumericField's `parseInt`: grouped or plain digits, else a whole number written as "1e3". */
export function parseCount(text: string): number | null {
  const w = parseWhole(text);
  if (w !== null) return w;
  const d = parseNumber(text);
  if (d !== null && Number.isFinite(d) && d === Math.round(d) && Math.abs(d) < 9e15) return d;
  return null;
}

export const CLAMP_NOTICE_MS = 2500;

export interface CountFieldProps {
  id: string;
  label: string;
  help?: string;
  value: string;
  min: number;
  max: number;
  onChange: (v: string) => void;
  decrementLabel: string;
  incrementLabel: string;
}

export function CountField({ id, label, help, value, min, max, onChange, decrementLabel, incrementLabel }: CountFieldProps) {
  const lastGood = useRef(value);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A value the caller set (a stepper, a reset) is the new value to go back to.
  if (parseCount(value) !== null && parseCount(value)! >= min && parseCount(value)! <= max) lastGood.current = value;

  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const commit = () => {
    const v = parseCount(value);
    if (v === null) {
      if (value !== lastGood.current) onChange(lastGood.current);
      return;
    }
    const c = clamp(v);
    const text = String(c);
    lastGood.current = text;
    if (text !== value) onChange(text);
    if (c !== v) {
      setNotice(words.clampedTo(text));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), CLAMP_NOTICE_MS);
    }
  };
  const n = parseCount(value);
  const step = (d: number) => onChange(String(clamp((n ?? min) + d)));
  return (
    <span className="qn-count" title={help}>
      <input
        id={id}
        className="qn-field qn-field-compact"
        type="text"
        inputMode="numeric"
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
      <button type="button" className="icon-btn" aria-label={decrementLabel} tabIndex={-1} onClick={() => step(-1)}>
        <Minus size={12} aria-hidden />
      </button>
      <button type="button" className="icon-btn" aria-label={incrementLabel} tabIndex={-1} onClick={() => step(1)}>
        <Plus size={12} aria-hidden />
      </button>
      {notice ? (
        <span className="qn-count-notice muted" role="status">
          {notice}
        </span>
      ) : null}
    </span>
  );
}
