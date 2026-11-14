// Fit from Data… (new in 2.1, ROADMAP D2): a panel, opened from the inspector's distribution
// editor, that turns measured times into the distribution a source or a station uses. Top to
// bottom it is the order of the work: the data (pasted, dropped or chosen as a file; a column
// chosen when there are several; event times turned into gaps), what the sample is (size, mean
// and SCV with their 95 % intervals, quartiles), the candidate families ranked — by maximum
// likelihood or by matching the mean and SCV — with how well each fits, the two pictures of the
// chosen one, and "Use This Distribution".
//
// The statistics are Rust's (`fit_distribution`, src-tauri/src/fit.rs); this reads the numbers
// out of the text (./parse.ts) and shows the answer.
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { open } from "@tauri-apps/plugin-dialog";
import { ChartColumn, TriangleAlert } from "lucide-react";
import { ChartFrame } from "../charts";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { holdModal } from "../lib/overlays";
import { PanelWindow } from "../lib/panel";
import { formatSig } from "../panes/inspector/distributions/numbers";
import { PanelHeader } from "../windows/parameters/chrome";
import { CdfChart, DensityChart } from "./charts";
import { candidatesOf, defaultChoice, MIN_POINTS, type FitCandidate, type FitMethod, type FitReport } from "./model";
import { defaultColumn, parseData, prepare, type ParsedData, type Prepared } from "./parse";
import { EXAMPLE_TEXT } from "./sample";
import { closeFitPanel, fitHosts, useFitRequest, type FitTarget } from "./store";
import { fitWords as w } from "./words";
import "../panes/inspector/inspector.css";
import "../workspace/files/files.css";
import "../runs/ui/runs-ui.css";
import "./fit.css";

/** Draws the panel when one is asked for. Mount it in App.tsx beside the other hosts. */
export function FitHost({ fallback = false }: { fallback?: boolean }) {
  useEffect(() => {
    if (fallback) return;
    fitHosts.mounted++;
    return () => {
      fitHosts.mounted--;
    };
  }, [fallback]);
  const r = useFitRequest();
  if (fallback && fitHosts.mounted > 0) return null;
  return r ? <FitPanel request={r} /> : null;
}

// Where no host is mounted (App.tsx mounts one; a test or another page may not), the first open makes one in a root of its own.
fitHosts.fallback = () => {
  fitHosts.fallback = null;
  if (typeof document === "undefined") return;
  createRoot(document.createElement("div")).render(<FitHost fallback />);
};

const f4 = (x: number | null | undefined) => (x === null || x === undefined ? w.none : formatSig(x, 4));
/** A p-value: three decimals, and "< 0.001" below that. */
export const pText = (p: number | null) => (p === null ? w.none : p < 0.001 ? "< 0.001" : p.toFixed(3));

/** What stops a fit, in a sentence, or null. */
export function dataProblem(text: string, parsed: ParsedData, prepared: Prepared | null, eventTimes: boolean): string | null {
  const p = w.problems;
  if (!text.trim()) return p.empty;
  if (!prepared || !parsed.columns.some((c) => c.values.length)) return p.noNumbers;
  if (prepared.negatives > 0) return p.negatives(prepared.negatives);
  if (prepared.data.length < MIN_POINTS) return p.tooFew(prepared.data.length, eventTimes);
  if (prepared.data.every((x) => x === 0)) return p.allZero;
  return null;
}

/** "Gamma(shape=3.051, scale=1.383)": a fitted law in one line. */
export function lawText(c: FitCandidate): string {
  return `${c.name} (${c.params.map((p) => `${p.name} = ${f4(p.value)}`).join(", ")})`;
}

const messageOf = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

function Stat({ label, value, unit, sub, help }: { label: string; value: string; unit?: string; sub?: string; help?: string }) {
  return (
    <div className="fit-stat" title={help}>
      <dt>{label}</dt>
      <dd>
        <span className="fit-stat-value">{value}</span>
        {unit ? <span className="fit-stat-unit"> {unit}</span> : null}
        {sub ? <span className="fit-stat-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

function FitPanel({ request }: { request: FitTarget }) {
  const uid = useId();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [decimalComma, setDecimalComma] = useState<boolean | null>(null);
  const [column, setColumn] = useState<number | null>(null);
  const [eventTimes, setEventTimes] = useState(false);
  const [dropZeros, setDropZeros] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [method, setMethod] = useState<FitMethod>("mle");
  const [choice, setChoice] = useState<string | null>(null);
  const [report, setReport] = useState<FitReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => parseData(text, decimalComma), [text, decimalComma]);
  const columnIndex = column !== null && column < parsed.columns.length ? column : defaultColumn(parsed);
  const active = parsed.columns[columnIndex] ?? null;
  const prepared = useMemo(() => (active ? prepare(active.values, { eventTimes, dropZeros }) : null), [active, eventTimes, dropZeros]);
  const problem = dataProblem(text, parsed, prepared, eventTimes);

  // The fit follows the data, a moment after they settle; an answer to older data is dropped.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (problem || !prepared) {
      setReport(null);
      setError(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api.fitDistribution({ data: prepared.data, kind: request.kind }).then(
        (r) => {
          if (seq.current !== mine) return;
          setReport(r);
          setError(null);
          setBusy(false);
        },
        (e) => {
          if (seq.current !== mine) return;
          setReport(null);
          setError(messageOf(e));
          setBusy(false);
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [prepared, problem, request.kind]);

  const list = report ? candidatesOf(report, method) : [];
  const chosenFamily = report ? (choice && list.some((c) => c.family === choice && c.applicable) ? choice : defaultChoice(report, method)) : null;
  const chosen = list.find((c) => c.family === chosenFamily) ?? null;

  const load = (name: string | null, body: string) => {
    setText(body);
    setFileName(name);
    setFileError(null);
    setColumn(null);
    setDecimalComma(null);
    setChoice(null);
  };
  const chooseFile = async () => {
    const release = holdModal();
    try {
      const picked = await open({ title: w.chooseFileTitle, multiple: false, directory: false, filters: [{ name: w.fileFilter, extensions: ["csv", "txt", "tsv", "dat"] }] });
      const path = typeof picked === "string" ? picked : Array.isArray(picked) && typeof picked[0] === "string" ? picked[0] : null;
      if (!path) return;
      const file = await api.fitReadFile(path);
      load(file.name, file.text);
    } catch (e) {
      setFileError(w.fileFailed(messageOf(e)));
    } finally {
      release();
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      file.text().then(
        (body) => (body.includes("\u0000") ? setFileError(w.fileFailed("")) : load(file.name, body)),
        (err) => setFileError(w.fileFailed(messageOf(err))),
      );
      return;
    }
    const plain = e.dataTransfer.getData("text/plain");
    if (plain) load(null, plain);
  };

  const cancel = () => closeFitPanel();
  const use = () => {
    if (!chosen || !chosen.applicable) return;
    request.apply(chosen.family, chosen.parameters);
    closeFitPanel();
  };
  const s = report?.summary ?? null;
  const zeros = prepared ? prepared.zeros : 0;

  return (
    <PanelWindow id="fit-distribution" title={w.panelTitle} band="table" modality="document" onClose={cancel}>
      <div className="panel-form fit-panel" data-panel="fit-distribution">
        <PanelHeader glyph={<Icon icon={ChartColumn} size={20} className="run-ui-glyph-info" />} title={w.panelTitle} subtitle={w.panelSubtitle(request.target)} />
        <div className="panel-content">
          <div className="fit-body">
            <section className="fit-section" aria-label={w.sectionData}>
              <h3 className="qn-sheet-section-title">{w.sectionData}</h3>
              <div className={`fit-drop${dragging ? " fit-drop-over" : ""}`} onDragOver={(e) => (e.preventDefault(), setDragging(true))} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
                <textarea
                  id={`${uid}-data`}
                  className="fit-data"
                  aria-label={w.dataLabel}
                  title={w.dataHelp}
                  placeholder={w.dataPlaceholder}
                  spellCheck={false}
                  rows={5}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setFileName(null);
                    setFileError(null);
                  }}
                />
                {dragging ? <div className="fit-drop-note">{w.dropHere}</div> : null}
              </div>
              <div className="fit-data-actions">
                <button type="button" className="btn" title={w.chooseFileHelp} onClick={() => void chooseFile()}>
                  {w.chooseFile}
                </button>
                <button type="button" className="btn" title={w.exampleHelp} onClick={() => load(null, EXAMPLE_TEXT)}>
                  {w.example}
                </button>
                <button type="button" className="btn" title={w.clearHelp} disabled={!text} onClick={() => load(null, "")}>
                  {w.clear}
                </button>
              </div>
              <div className="fit-options">
                {parsed.columns.length > 1 ? (
                  <label className="fit-option" title={w.columnHelp}>
                    <span>{w.column}</span>
                    <select className="qn-field" value={columnIndex} onChange={(e) => (setColumn(Number(e.target.value)), setChoice(null))}>
                      {parsed.columns.map((c) => (
                        <option key={c.index} value={c.index}>
                          {w.columnName(c.index, c.header, c.values.length)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="fit-option fit-check" title={w.eventTimesHelp}>
                  <input type="checkbox" checked={eventTimes} onChange={(e) => (setEventTimes(e.target.checked), setChoice(null))} />
                  <span>{w.eventTimes}</span>
                </label>
                {parsed.hasComma ? (
                  <label className="fit-option fit-check" title={w.decimalCommaHelp}>
                    <input type="checkbox" checked={parsed.decimalComma} onChange={(e) => (setDecimalComma(e.target.checked), setColumn(null), setChoice(null))} />
                    <span>{w.decimalComma}</span>
                  </label>
                ) : null}
                {zeros > 0 ? (
                  <label className="fit-option fit-check" title={w.dropZerosHelp}>
                    <input type="checkbox" checked={dropZeros} onChange={(e) => setDropZeros(e.target.checked)} />
                    <span>{w.dropZeros(zeros)}</span>
                  </label>
                ) : null}
              </div>
              <div className="fit-status" role="status" data-fit-status>
                {fileError ? <p className="fit-problem">{fileError}</p> : null}
                {active && active.values.length ? (
                  <p>
                    {fileName ? `${w.fromFile(fileName)} ` : ""}
                    {eventTimes && prepared ? w.gaps(active.values.length, Math.max(0, active.values.length - 1), prepared.sorted) : w.read(active.values.length)}
                    {active.skipped.length ? ` ${w.skipped(active.skipped)}` : ""}
                  </p>
                ) : null}
                {parsed.ambiguous ? <p className="fit-warning">{w.ambiguousComma}</p> : null}
                {problem && text.trim() ? (
                  <p className="fit-problem" data-fit-problem>
                    {problem}
                  </p>
                ) : null}
                {error ? (
                  <p className="fit-problem" data-fit-problem>
                    {w.failed(error)}
                  </p>
                ) : null}
              </div>
            </section>

            {!report ? (
              <div className="empty-state fit-empty" data-fit-empty>
                <p>{busy ? w.fitting : !text.trim() ? w.problems.empty : (problem ?? (error ? w.failed(error) : w.fitting))}</p>
              </div>
            ) : (
              <>
                <section className="fit-section" aria-label={w.sectionSummary}>
                  <h3 className="qn-sheet-section-title">{w.sectionSummary}</h3>
                  {s ? (
                    <dl className="fit-stats" data-fit-summary>
                      <Stat label={w.n} value={s.n.toLocaleString("en-US")} />
                      <Stat label={w.mean} value={f4(s.mean)} unit={w.timeUnit} sub={w.interval(f4(s.meanInterval[0]), f4(s.meanInterval[1]))} />
                      <Stat label={w.scv} value={f4(s.scv)} sub={w.interval(f4(s.scvInterval[0]), f4(s.scvInterval[1]))} help={w.scvHelp} />
                      <Stat label={w.rate} value={f4(1 / s.mean)} unit={w.rateUnit} />
                      <Stat label={w.sd} value={f4(s.sd)} unit={w.timeUnit} />
                      <Stat label={w.range} value={`${f4(s.min)} · ${f4(s.median)} · ${f4(s.max)}`} />
                      <Stat label={w.quartiles} value={`${f4(s.q1)} · ${f4(s.q3)}`} />
                    </dl>
                  ) : null}
                  <p className="qn-sheet-section-footer">{s && s.intervalMethod === "bootstrap" ? w.intervalBootstrap(s.resamples) : w.intervalAsymptotic}</p>
                  {report.warnings.map((line) => (
                    <p key={line} className="fit-warning" data-fit-warning>
                      <Icon icon={TriangleAlert} size={12} aria-hidden /> {line}
                    </p>
                  ))}
                </section>

                <section className="fit-section" aria-label={w.sectionCandidates}>
                  <div className="fit-section-head">
                    <h3 className="qn-sheet-section-title">{w.sectionCandidates}</h3>
                    <div className="insp-segmented" role="radiogroup" aria-label={w.fitBy} title={w.fitByHelp}>
                      {(["mle", "moments"] as const).map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? "is-on" : undefined} data-fit-method={m} onClick={() => (setMethod(m), setChoice(null))}>
                          {w.methods[m]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="fit-method-note" data-fit-method-note>
                    {method === "mle" ? w.mleNote : w.momentsNote}
                  </p>
                  <div className="fit-table-wrap">
                    <table className="fit-table" data-fit-table>
                      <caption className="sr-only">{w.table}</caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className="sr-only">{w.colChoose}</span>
                          </th>
                          <th scope="col" className="fit-left">{w.colFamily}</th>
                          <th scope="col" className="fit-left">{w.colParameters}</th>
                          <th scope="col">{w.colMean}</th>
                          <th scope="col" title={w.scvHelp}>{w.colScv}</th>
                          <th scope="col" title={w.aicHelp}>{w.colAic}</th>
                          <th scope="col" title={w.ksHelp}>{w.colKs}</th>
                          <th scope="col" title={w.ksPHelp}>
                            {w.colKsP}
                            <span aria-hidden="true"> *</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((c) => {
                          const on = c.family === chosenFamily;
                          const recommended = method === "mle" && c.family === report.recommended;
                          return (
                            <tr key={c.family} data-family={c.family} data-chosen={on || undefined} data-na={!c.applicable || undefined} onClick={() => c.applicable && setChoice(c.family)}>
                              <td>{c.applicable ? <input type="radio" name={`${uid}-family`} aria-label={w.choose(c.name)} checked={on} onChange={() => setChoice(c.family)} /> : null}</td>
                              <th scope="row" className="fit-left">
                                {c.name}
                                {recommended ? <span className="fit-badge">{w.recommended}</span> : null}
                              </th>
                              {c.applicable ? (
                                <>
                                  <td className="fit-left">
                                    {c.params.map((p) => `${p.name} = ${f4(p.value)}`).join(", ")}
                                    {c.note ? <span className="fit-note">{c.note}</span> : null}
                                  </td>
                                  <td>{f4(c.mean)}</td>
                                  <td>{f4(c.scv)}</td>
                                  <td title={c.logLikelihood !== null ? `${w.colLogLik} ${f4(c.logLikelihood)}` : undefined}>{c.aic === null ? w.none : c.aic.toFixed(1)}</td>
                                  <td>{c.ks === null ? w.none : c.ks.toFixed(3)}</td>
                                  <td>{pText(c.ksP)}</td>
                                </>
                              ) : (
                                <td className="fit-left fit-na" colSpan={6}>
                                  {w.notApplicable}: {c.note}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {method === "mle" && report.recommended ? (
                    <p className="fit-recommend" data-fit-recommend>
                      {w.recommendedLine(report.mle.find((c) => c.family === report.recommended)?.name ?? report.recommended, report.reason)}
                    </p>
                  ) : null}
                  <p className="qn-sheet-section-footer">* {w.ksCaveat}</p>
                </section>

                <section className="fit-charts" aria-label={w.densityTitle}>
                  <ChartFrame minWidth={300}>{({ width, fontScale }) => <DensityChart report={report} list={list} chosen={chosen} width={width} fontScale={fontScale} />}</ChartFrame>
                  <ChartFrame minWidth={300}>{({ width, fontScale }) => <CdfChart report={report} list={list} chosen={chosen} width={width} fontScale={fontScale} />}</ChartFrame>
                </section>
                <p className="qn-sheet-section-footer fit-unit-note">{w.unitNote}</p>
              </>
            )}
          </div>
        </div>
        <footer className="panel-footer">
          <div className="panel-footer-note">
            {chosen && chosen.applicable ? (
              <span className="fit-footer-law" role="status" data-fit-law>
                {lawText(chosen)}
              </span>
            ) : null}
          </div>
          <button type="button" className="btn" title={w.cancelHelp} aria-keyshortcuts="Escape" onClick={cancel}>
            {w.cancel}
          </button>
          <button type="button" className="btn primary" title={chosen && chosen.applicable ? w.useHelp(lawText(chosen), request.target) : w.useBlocked} disabled={!chosen || !chosen.applicable} onClick={use}>
            {w.use}
          </button>
        </footer>
      </div>
    </PanelWindow>
  );
}
