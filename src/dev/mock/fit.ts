// Fit from Data… in the browser preview and the tests (src-tauri/src/fit.rs answers in the app).
// The statistics are Rust's alone, so the preview does not compute any: it answers from recorded
// answers (fit-fixtures.json, which a Rust test keeps equal to what `fit` returns) for the two
// samples it knows — the panel's example data, and the gaps of the preview's data file — and says
// plainly that it cannot fit anything else.
import type { DataFile, FitReport, FitRequest } from "../../fit/model";
import type { MockHandlers } from "../../test/tauri";
import fixtures from "./fit-fixtures.json";

interface FitCase {
  name: string;
  kind: string;
  data: number[];
  timestamps?: number[];
  report: FitReport;
}

export const fitCases = (fixtures as unknown as { cases: FitCase[] }).cases;
export const fitCase = (name: string): FitCase => fitCases.find((c) => c.name === name)!;

/** The file the preview's Choose File… reads: a heading, a row number and 41 arrival times. */
export const MOCK_DATA_FILE: DataFile = {
  name: "arrivals.csv",
  text: ["customer,arrival time", ...(fitCase("gaps").timestamps ?? []).map((t, i) => `${i + 1},${t}`)].join("\n"),
};

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((x, i) => Math.abs(x - [...b].sort((p, q) => p - q)[i]) < 1e-9);

export function mockFit(request: FitRequest): FitReport {
  const hit = fitCases.find((c) => same(c.data, request.data));
  if (!hit) throw { kind: "unavailable", message: "The browser preview fits only its two recorded samples (Use Example Data, or Choose File…). The app fits any data." };
  if (hit.kind === request.kind) return hit.report;
  // The same numbers for the other kind of node: the exponential row is named for it.
  const rename = (list: FitReport["mle"]) =>
    list.map((c) =>
      c.family === "exponential" && request.kind === "source"
        ? { ...c, family: "poisson", name: "Poisson process (exponential gaps)", parameters: c.parameters.replace("rate=", "lambda="), params: c.params.map((p) => ({ ...p, key: "lambda" })) }
        : c.family === "poisson" && request.kind === "station"
          ? { ...c, family: "exponential", name: "Exponential", parameters: c.parameters.replace("lambda=", "rate="), params: c.params.map((p) => ({ ...p, key: "rate" })) }
          : c,
    );
  const other = request.kind === "source" ? "poisson" : "exponential";
  return { ...hit.report, mle: rename(hit.report.mle), moments: rename(hit.report.moments), recommended: hit.report.recommended === "exponential" || hit.report.recommended === "poisson" ? other : hit.report.recommended };
}

export function fitHandlers(): MockHandlers {
  return {
    fit_distribution: ({ request }: { request: FitRequest }) => mockFit(request),
    fit_read_file: (): DataFile => MOCK_DATA_FILE,
  };
}
