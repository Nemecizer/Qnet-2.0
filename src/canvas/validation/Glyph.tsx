// The mark of a problem's severity (new in 2.1, ROADMAP C4). Shape as well as colour tells them
// apart: an error is a filled octagon, a warning an outlined triangle, a note an outlined circle.
import type { DiagnosticSeverity } from "./model";

const SHAPE: Record<DiagnosticSeverity, string> = {
  error: "M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1Z",
  warning: "M8 1.6 15 14.2H1Z",
  info: "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13Z",
};

export function SeverityGlyph({ severity, size = 16 }: { severity: DiagnosticSeverity; size?: number }) {
  const lift = severity === "warning" ? 1.4 : 0;
  return (
    <svg className="problem-glyph" data-severity={severity} data-shape={severity === "error" ? "filled" : "outline"} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="problem-glyph-shape" d={SHAPE[severity]} strokeWidth={1.5} strokeLinejoin="round" />
      {severity === "info" ? (
        <path className="problem-glyph-mark" d="M8 7.2v4.2M8 4.6v.4" fill="none" strokeWidth={1.7} strokeLinecap="round" />
      ) : (
        <path className="problem-glyph-mark" d={`M8 ${4.4 + lift}v${4.2 - lift / 2}M8 ${11.3 + lift / 2}v.3`} fill="none" strokeWidth={1.7} strokeLinecap="round" />
      )}
    </svg>
  );
}
