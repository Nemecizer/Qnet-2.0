// One problem as it reads in the canvas popover and in the list (new in 2.1, ROADMAP C4): its
// severity (mark and word), its sentence, and its fixes as buttons.
import type { Editor } from "../../editor/editor";
import { fixesFor, type Fix } from "./fixes";
import { SeverityGlyph } from "./Glyph";
import type { Diagnostic } from "./model";
import { validationWords as w } from "./words";

export function ProblemText({ d }: { d: Diagnostic }) {
  return (
    <>
      <SeverityGlyph severity={d.severity} />
      <span>
        <span className="problem-severity">{w.severity[d.severity]}.</span> {w.sentence(d)}
      </span>
    </>
  );
}

/** `inspector: false` leaves "Open in Inspector" to another item of the same node (it is said once per popover). */
export function FixButtons({ d, editor, onFix, inspector = true }: { d: Diagnostic; editor: Editor; onFix: (fix: Fix) => void; inspector?: boolean }) {
  const fixes = fixesFor(d, editor).filter((f) => inspector || f.id !== "inspector");
  if (!fixes.length) return null;
  return (
    <div className="problem-fixes">
      {fixes.map((f, i) => (
        <button key={f.id} type="button" className={i === 0 && f.id !== "inspector" ? "btn primary" : "btn"} data-fix={f.id} onClick={() => onFix(f)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}
