// The Results workspace's commands in the browser preview and the tests (src-tauri/src/results_export.rs):
// the current network's fingerprint, and the CSV / JSON exports of the preview's records
// (src/dev/mock/runs.ts `mockRuns.records`, 0.90.34's own records replayed).
//
// Rust is the exact one (it hashes the snapshot as 0.90.34 did and spells every number as Swift's
// `String(Double)`). The preview stands in: a network that is the snapshot a replayed record was
// filed from gets that record's fingerprint (so it reads as current until the network changes),
// anything else a hash of its own; the exports follow ResultsExport.csv column for column with
// JavaScript's numbers respelled the way Swift spells them.
import type { MockHandlers } from "../../test/tauri";
import { mockRuns } from "./runs";

/** What the preview's Save panels wrote: path → text. */
export const savedResultExports: Record<string, string> = {};

type Doc = { nodes?: Record<string, unknown>[]; links?: Record<string, unknown>[]; infiniteBuffers?: boolean };

/** The parts of a network the fingerprint reads, in a form that ignores defaults the writer adds. */
function canonical(doc: Doc | null | undefined): string {
  const byId = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  const nodes = (doc?.nodes ?? [])
    .map((n) => [String(n.id).toUpperCase(), n.kind, n.name, n.position, n.bufferSize ?? 1, n.numberOfServers ?? 1, n.distribution ?? "", n.distributionParameters ?? ""])
    .sort(byId);
  const links = (doc?.links ?? [])
    .map((l) => [String(l.id).toUpperCase(), String(l.fromNodeID).toUpperCase(), String(l.toNodeID).toUpperCase(), l.routingProbability ?? 1, l.customerClass ?? 0, l.toCustomerClass ?? null])
    .sort(byId);
  return JSON.stringify([nodes, links, !!doc?.infiniteBuffers]);
}

/** A 64-hex-digit stand-in hash (FNV-1a, eight lanes). */
function hash64(text: string): string {
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ lane;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export function mockFingerprint(document: Doc): string {
  const c = canonical(document);
  for (const r of mockRuns.records) {
    const p = r.provenance as { networkSnapshot?: Doc; networkFingerprint?: string };
    if (p.networkSnapshot && canonical(p.networkSnapshot) === c && p.networkFingerprint) return p.networkFingerprint;
  }
  return hash64(c);
}

/** Swift's `String(Double)`: "1.0", "0.5", "1e-05", "1e+16". */
export function swiftNumber(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 9007199254740992)) {
    const [m, e] = x.toExponential().split("e");
    const sign = e.startsWith("-") ? "-" : "+";
    return `${m}e${sign}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}

const CSV_HEADER = [
  "run_id", "network", "network_fingerprint", "stale", "status", "method_id", "method", "model_layer", "fidelity", "started_at",
  "completed_at", "elapsed_seconds", "station_id", "station", "class", "metric", "estimate", "unit", "standard_error", "half_width",
  "ci_lower", "ci_upper", "confidence_level", "sample_size", "residual", "discretization", "refinement_delta", "note", "seed", "parameters", "warnings",
];

const escape = (f: string) => (/[,"\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);
const num = (v: unknown) => (typeof v === "number" ? swiftNumber(v) : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mockCsv(records: any[], currentFingerprint: string | null): string {
  const rows = [CSV_HEADER.map(escape).join(",")];
  for (const run of records) {
    const p = run.provenance ?? {};
    const stale = currentFingerprint == null ? "" : p.networkFingerprint !== currentFingerprint ? "true" : "false";
    const params = p.parameters ?? {};
    const parameterText = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("; ");
    const ms = run.measurements?.length ? run.measurements : [{ stationName: "", metric: "", estimate: NaN, unit: "" }];
    const re = run.runEvidence ?? {};
    for (const m of ms) {
      const u = m.uncertainty ?? {};
      const e = m.numericalEvidence ?? {};
      const half = typeof u.lowerBound === "number" && typeof u.upperBound === "number" ? (u.upperBound - u.lowerBound) / 2 : undefined;
      const fields = [
        run.id, p.networkTitle, p.networkFingerprint, stale, run.status, run.method?.identifier, run.method?.displayName, run.method?.layer, run.method?.fidelity,
        run.startedAt, str(run.completedAt), num(run.elapsedSeconds), str(m.stationID), m.stationName, typeof m.customerClass === "number" ? String(m.customerClass + 1) : "",
        m.metric, Number.isNaN(m.estimate) ? "" : swiftNumber(m.estimate), m.unit ?? "", num(u.standardError), num(half), num(u.lowerBound), num(u.upperBound),
        num(u.confidenceLevel), typeof u.sampleSize === "number" ? String(u.sampleSize) : "", num(e.residual ?? re.residual), str(e.discretization ?? re.discretization),
        num(e.refinementDelta ?? re.refinementDelta), str(m.note ?? e.convergenceNote ?? re.convergenceNote), typeof p.seed === "number" ? String(p.seed) : "",
        parameterText, (run.warnings ?? []).join("; "),
      ].map((f) => escape(String(f ?? "")));
      rows.push(fields.join(","));
    }
  }
  return rows.join("\n") + "\n";
}

/** JSONEncoder's `[.prettyPrinted, .sortedKeys]` layout, near enough for the preview. */
function sorted(v: any): any {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}
export function mockJson(records: any[]): string {
  return JSON.stringify(sorted(records), null, 2).replace(/^(\s*"[^"]*"):/gm, "$1 :").replace(/\//g, "\\/");
}

function exportText(ids: string[], format: string, currentFingerprint: string | null): string {
  const records = ids.map((id) => mockRuns.records.find((r) => r.id === id.toUpperCase())).filter(Boolean);
  if (format === "csv") return mockCsv(records, currentFingerprint);
  if (format === "json") return mockJson(records);
  throw { kind: "invalid", message: `There's no results export called “${format}”.` };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function resultsHandlers(): MockHandlers {
  for (const k of Object.keys(savedResultExports)) delete savedResultExports[k];
  return {
    results_fingerprint: ({ document }: { document: Doc }) => mockFingerprint(document),
    results_export_text: ({ ids, format, currentFingerprint }: { ids: string[]; format: string; currentFingerprint: string | null }) => exportText(ids, format, currentFingerprint ?? null),
    results_export_save: ({ path, ids, format, currentFingerprint }: { path: string; ids: string[]; format: string; currentFingerprint: string | null }) => {
      const text = exportText(ids, format, currentFingerprint ?? null);
      savedResultExports[path] = text;
      return path.split("/").pop() ?? path;
    },
  };
}
