// The 13 panes' rows, section by section, as 0.90.34's SettingsView.swift lays them out
// (GeneralPane, SolverEnginePane, SimulationPane, ExactSimulationPane, LinearProgramPane,
// FiniteLPPane, FiniteElementPane, SpectralPane, TestSetsPane, OutputFormatPane, AppearancePane,
// HelpPane, AIAssistantPane). The General pane's All Settings section is in general.tsx.
import { AiKeyField, AiModelRefresh, AiTestConnection } from "../../panes/ai/settingsControls";
import { CATALOG, CATALOG_DATE, modelAdvice, pickerSections } from "../../panes/ai/catalog";
import { useEffect, useState, type ReactNode } from "react";
import { List } from "lucide-react";
import { Icon } from "../../components/Icon";
import { GeneralPane } from "./general";
import type { PaneId } from "./registry";
import {
  Footnote, FontRow, IconMenu, MenuRow, NumberRow, RangeRow, Row, Section, SliderRow, TextField, ToggleRow,
  num, useAnchor, useSettingsCtx, w,
} from "./rows";
import { linearProgramPerformanceHints, settingsWords } from "./words";

const s = settingsWords.sections;

/** core/src/export/srbm_orthant.rs `recommended_bnalp_grid` (0.90.34 `recommendedBNAlpGrid`). */
export function recommendedBNAlpGrid(d: number): [number, number] {
  if (d <= 2) return [100, 6];
  if (d === 3) return [25, 5];
  if (d === 4) return [12, 4];
  if (d === 5) return [10, 3];
  if (d === 6) return [6, 3];
  if (d === 7) return [5, 3];
  if (d === 8) return [4, 3];
  if (d <= 10) return [3, 3];
  return [2, 2];
}

/** core/src/export/srbm_box.rs `recommended_finite_lp_grid` (0.90.34 `recommendedFiniteLPGrid`). */
export function recommendedFiniteLPGrid(d: number): [number, number] {
  if (d <= 1) return [64, 8];
  if (d === 2) return [20, 6];
  if (d === 3) return [12, 4];
  if (d === 4) return [8, 3];
  return [6, 3];
}

/** AppSettings.femMeshCap(forDimension:). */
export function femMeshCap(d: number): number {
  if (d < 4) return 20;
  if (d === 4) return 8;
  if (d === 5) return 6;
  return 4;
}

/** ProcessInfo.activeProcessorCount, as the window shows it. */
function cores(): number {
  return Math.max(1, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1);
}

function ParityNotes() {
  const { ref, cls } = useAnchor("engine.parity");
  return (
    <div ref={ref} className={`set-row set-prose${cls}`} data-anchor="engine.parity">
      {settingsWords.engineFooters.parity.map((p) => (
        <Footnote key={p}>{p}</Footnote>
      ))}
    </div>
  );
}

function SolverEnginePane() {
  const f = settingsWords.engineFooters;
  return (
    <>
      <Section title={s.regenerative} footer={<Footnote>{f.regenerative}</Footnote>}>
        <MenuRow id="engine.regenerative" options={[0, 1]} />
      </Section>
      <Section title={s.qbd} footer={<Footnote>{f.qbd}</Footnote>}>
        <MenuRow id="engine.qbd" options={[0, 1]} />
      </Section>
      <Section title={s.ctmc} footer={<Footnote>{f.ctmc}</Footnote>}>
        <MenuRow id="engine.ctmc" options={[0, 1]} />
      </Section>
      <Section title={s.whyTwo}>
        <ParityNotes />
      </Section>
    </>
  );
}

function SimulationPane() {
  const t = settingsWords.sim;
  return (
    <>
      <Section title={s.execution}>
        <MenuRow id="sim.parallel" options={[0, 1, 2]} />
      </Section>
      <Section title={s.finiteBuffers} footer={<Footnote>{t.blockingFooter}</Footnote>}>
        <MenuRow id="sim.blocking" options={[0, 1, 2]} />
      </Section>
      <Section title={s.runLength} footer={<Footnote>{t.runLengthFooter}</Footnote>}>
        <NumberRow id="sim.replications" int step={10} />
        <NumberRow id="sim.warmup" int step={100_000} />
        <NumberRow id="sim.time" int step={500_000} />
      </Section>
      <Section title={s.reproducibility}>
        <NumberRow id="sim.seed" int toggle="sim.seedFixed" />
      </Section>
    </>
  );
}

function ExactSimulationPane() {
  const c = useSettingsCtx();
  const t = settingsWords.mlmc;
  const v = c.values;
  const gammas = [0.01, 0.05, 0.1, 0.25, 0.5];
  // snapGamma: a stored γ that isn't an option snaps to the nearest one when the pane opens.
  useEffect(() => {
    const g = num(v["mlmc.gamma"], 0.05);
    if (gammas.some((o) => o === g)) return;
    const nearest = gammas.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
    void c.set({ "mlmc.gamma": nearest });
  }, []);
  const eps = num(v["mlmc.epsilon"], 0.01);
  let caution: string | null = null;
  if (eps > 0 && eps < 0.001) {
    const multiple = (0.01 / eps) * (0.01 / eps);
    caution = t.epsilonCaution(
      eps.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 4 }),
      multiple.toLocaleString("en-US", { maximumSignificantDigits: 3 }),
    );
  }
  const minS = num(v["mlmc.minSamples"]);
  const maxS = num(v["mlmc.maxSamples"]);
  const batch = num(v["mlmc.batchSize"]);
  const orderError = minS > maxS ? t.minOverMax : batch > maxS ? t.batchOverMax : null;
  const adaptive = v["mlmc.adaptive"] === true;
  const n = cores();
  return (
    <>
      <Section title={s.accuracy}>
        <NumberRow id="mlmc.epsilon" int={false} step={2} log digits={[1, 4]} warning={caution} />
        <MenuRow
          id="mlmc.gamma"
          options={gammas}
          titles={(g) => t.gammaTitle(g)}
          details={(g) => t.gammaDetail(Math.round(1 / g))}
        />
      </Section>
      <Section title={s.overrides} footer={<Footnote>{t.overridesFooter}</Footnote>}>
        <NumberRow id="mlmc.T" int={false} step={1} digits={[0, 2]} toggle="mlmc.overrideT" />
        <NumberRow id="mlmc.L" int toggle="mlmc.overrideL" />
        <NumberRow id="mlmc.N" int step={1000} toggle="mlmc.overrideN" disabled={adaptive} />
      </Section>
      <Section title={s.variance}>
        <ToggleRow id="mlmc.antithetic" />
        <NumberRow id="mlmc.replications" int />
      </Section>
      <Section title={s.adaptive} footer={<Footnote warning>{t.adaptiveFooter}</Footnote>}>
        <ToggleRow id="mlmc.adaptive" />
        <NumberRow id="mlmc.batchSize" int step={100} disabled={!adaptive} />
        <NumberRow id="mlmc.minSamples" int step={1000} disabled={!adaptive} crossCheck={orderError} />
        <NumberRow id="mlmc.maxSamples" int step={10_000} disabled={!adaptive} crossCheck={orderError} />
      </Section>
      <Section title={s.parallelism}>
        <MenuRow id="mlmc.backend" options={[0, 1, 2, 3]} />
        <NumberRow
          id="mlmc.threads"
          int
          caption={t.threadsCaption(n)}
          placeholder={t.threadsPlaceholder(n)}
          zeroMeansAuto
          range={[0, Math.max(1, n)]}
          disabled={num(v["mlmc.backend"]) === 3}
        />
      </Section>
      <Section title={s.reproducibility}>
        <NumberRow id="mlmc.seed" int toggle="mlmc.seedFixed" />
      </Section>
    </>
  );
}

/** LPDiscretisationSection: the recommendation for the open network, the auto switches (local
 * state seeded from the stored 0 = auto), the two fields and the grid-type picker. */
function LPDiscretisation({ prefix, fallback, recommend, footer, gridType }: { prefix: "lp" | "flp"; fallback: number; recommend: (d: number) => [number, number]; footer: string; gridType: ReactNode }) {
  const c = useSettingsCtx();
  const t = settingsWords.lp;
  const gridKey = `${prefix}.gridN`;
  const basisKey = `${prefix}.basisM`;
  const grid = num(c.values[gridKey]);
  const basis = num(c.values[basisKey]);
  const [manualGrid, setManualGrid] = useState(grid !== 0);
  const [manualBasis, setManualBasis] = useState(basis !== 0);
  // Reset (or any other write) puts the switches back in step with the stored value.
  useEffect(() => setManualGrid((m) => (grid === 0 ? false : m || true)), [grid]);
  useEffect(() => setManualBasis((m) => (basis === 0 ? false : m || true)), [basis]);
  const d = c.dimension && c.dimension > 0 ? c.dimension : null;
  const rec = recommend(d ?? fallback);
  const autoSwitch = (id: string, manual: boolean, setManual: (m: boolean) => void, key: string, current: number, recommended: number) => (
    <Row
      id={id}
      control={
        <input
          type="checkbox"
          role="switch"
          className="set-switch"
          aria-label={w(id).label}
          title={w(id).help}
          checked={!manual}
          onChange={(e) => {
            const auto = e.target.checked;
            setManual(!auto);
            if (auto) void c.set({ [key]: 0 });
            else if (current === 0) void c.set({ [key]: recommended });
          }}
        />
      }
    />
  );
  return (
    <Section title={s.discretisation} footer={<Footnote>{footer}</Footnote>}>
      <Row
        id={`${prefix}.recommended`}
        caption={d ? t.forOpen(d) : t.noneOpen(fallback)}
        control={
          <span className="set-readonly mono" aria-label={t.recommendedLabel(rec[0], rec[1])}>
            {t.recommended(rec[0], rec[1])}
          </span>
        }
      />
      {autoSwitch(`${prefix}.autoGrid`, manualGrid, setManualGrid, gridKey, grid, rec[0])}
      <NumberRow id={gridKey} int range={[1, 1000]} zeroMeansAuto placeholder={String(rec[0])} disabled={!manualGrid} />
      {autoSwitch(`${prefix}.autoBasis`, manualBasis, setManualBasis, basisKey, basis, rec[1])}
      <NumberRow id={basisKey} int range={[1, 64]} zeroMeansAuto placeholder={String(rec[1])} disabled={!manualBasis} />
      {gridType}
    </Section>
  );
}

function LinearProgramPane() {
  const t = settingsWords.lp;
  const [hints, setHints] = useState(false);
  return (
    <>
      <LPDiscretisation prefix="lp" fallback={3} recommend={recommendedBNAlpGrid} footer={t.tableFooter} gridType={<MenuRow id="lp.gridType" options={[0, 1, 2]} />} />
      <Section title={s.solver} footer={<Footnote>{t.solverFooter}</Footnote>}>
        <MenuRow id="lp.solver" options={[0, 1, 2, 3]} />
      </Section>
      <Section title={s.stability}>
        <ToggleRow id="lp.basisNormalize" />
        <NumberRow id="lp.smoothness" int={false} step={0.0001} digits={[0, 6]} />
      </Section>
      <Section title={s.runtime}>
        <ToggleRow id="lp.askBeforeRun" />
        <ToggleRow id="lp.multiLevel" />
      </Section>
      <Section title={s.reference}>
        <Row
          id="lp.hints"
          control={
            <button type="button" className="btn" title={w("lp.hints").help} aria-expanded={hints} onClick={() => setHints(!hints)}>
              {w("lp.hints").label}
            </button>
          }
        />
        {hints && (
          <pre className="set-reference" aria-label={t.hintsTitle}>
            {linearProgramPerformanceHints}
          </pre>
        )}
      </Section>
    </>
  );
}

function FiniteLPPane() {
  const t = settingsWords.lp;
  return (
    <>
      <LPDiscretisation prefix="flp" fallback={2} recommend={recommendedFiniteLPGrid} footer={t.flpTableFooter} gridType={<MenuRow id="flp.gridType" options={[0, 1]} />} />
      <Section title={s.solver} footer={<Footnote>{t.flpSolverFooter}</Footnote>}>
        <MenuRow id="flp.solver" options={[0, 1, 2]} />
      </Section>
      <Section title={s.stability} footer={<Footnote>{t.flpStabilityFooter}</Footnote>}>
        <ToggleRow id="flp.basisNormalize" />
      </Section>
    </>
  );
}

function FiniteElementPane() {
  const c = useSettingsCtx();
  const t = settingsWords.fem;
  const mesh = num(c.values["fem.meshSize"]);
  const d = c.dimension;
  const caution = d && d > 0 && mesh > femMeshCap(d) ? t.meshCaution(mesh, femMeshCap(d), d) : null;
  return (
    <>
      <Section title={s.quadrature}>
        <MenuRow id="fem.solver" options={[0, 1]} />
      </Section>
      <Section title={s.mesh} footer={<Footnote>{t.meshFooter(femMeshCap(3), femMeshCap(4), femMeshCap(5), femMeshCap(6))}</Footnote>}>
        <NumberRow id="fem.meshSize" int warning={caution} />
      </Section>
    </>
  );
}

function SpectralPane() {
  const c = useSettingsCtx();
  const t = settingsWords.spectral;
  const caution = num(c.values["sm.degree"]) > 10 && c.values["sm.legendre"] !== true ? t.basisCaution : null;
  return (
    <Section title={s.basis} footer={<Footnote>{t.footer}</Footnote>}>
      <NumberRow id="sm.degree" int />
      <ToggleRow id="sm.legendre" />
      {caution && (
        <div className="set-message warning" role="status">
          {caution}
        </div>
      )}
    </Section>
  );
}

/** Number of ρ values in the start … end grid at the given step (TestSetsPane.spectralRhoCount). */
export function spectralRhoCount(start: number, end: number, step: number): number {
  if (!(step > 0) || end < start) return 0;
  return Math.floor((end - start) / step + 1e-9) + 1;
}

function TestSetsPane() {
  const c = useSettingsCtx();
  const t = settingsWords.testSets;
  const v = c.values;
  const rhos = spectralRhoCount(num(v["testset.spc.rhoStart"]), num(v["testset.spc.rhoEnd"]), num(v["testset.spc.rhoStep"]));
  const summary = rhos > 0 ? t.sweepSummary(num(v["testset.spc.numCases"]), rhos) : t.emptyGrid;
  const block = (p: "inf" | "fin" | "spc") => (
    <>
      <RangeRow id={`testset.${p}.stations`} lo={`testset.${p}.stationsLo`} hi={`testset.${p}.stationsHi`} int />
      <RangeRow id={`testset.${p}.classes`} lo={`testset.${p}.classesLo`} hi={`testset.${p}.classesHi`} int />
    </>
  );
  return (
    <>
      <Section title={s.infinite} footer={<Footnote>{t.infFooter}</Footnote>}>
        {block("inf")}
        <RangeRow id="testset.inf.rho" lo="testset.inf.rhoLo" hi="testset.inf.rhoHi" int={false} step={0.05} />
        <NumberRow id="testset.inf.numCases" int />
        <MenuRow id="testset.inf.topology" options={[0, 1, 2, 3]} />
      </Section>
      <Section title={s.finite} footer={<Footnote>{t.finFooter}</Footnote>}>
        {block("fin")}
        <RangeRow id="testset.fin.rho" lo="testset.fin.rhoLo" hi="testset.fin.rhoHi" int={false} step={0.05} />
        <NumberRow id="testset.fin.numCases" int />
        <MenuRow id="testset.fin.topology" options={[0, 1, 2, 3]} />
      </Section>
      <Section title={s.spectral} footer={<Footnote>{t.spcFooter(summary)}</Footnote>}>
        {block("spc")}
        <RangeRow id="testset.spc.rhoRange" lo="testset.spc.rhoStart" hi="testset.spc.rhoEnd" int={false} step={0.05} strict />
        <NumberRow id="testset.spc.rhoStep" int={false} step={0.01} digits={[2, 2]} />
        <NumberRow id="testset.spc.numCases" int />
        <MenuRow id="testset.spc.topology" options={[0, 1, 2, 3]} />
      </Section>
    </>
  );
}

function OutputFormatPane() {
  const c = useSettingsCtx();
  const d = Math.max(0, Math.min(9, Math.round(num(c.values["output.decimals"], 6))));
  return (
    <Section title={s.numeric} footer={<Footnote>{settingsWords.output.footer}</Footnote>}>
      <NumberRow id="output.decimals" int caption={settingsWords.output.example(`ρ = ${(0.8123456789).toFixed(d)}`)} />
    </Section>
  );
}

function AppearancePane() {
  const t = settingsWords.panes;
  return (
    <>
      <Section title={s.shell} footer={<Footnote>{t.shellFooter}</Footnote>}>
        <FontRow id="shell.fontName" proportional={false} />
        <SliderRow id="shell.fontSize" step={1} digits={[0, 0]} />
        <ToggleRow id="shell.classicTheme" />
      </Section>
      <Section title={s.status} footer={<Footnote>{t.statusFooter}</Footnote>}>
        <SliderRow id="status.fontSize" step={1} digits={[0, 0]} />
      </Section>
      <Section title={s.ai} footer={<Footnote>{t.aiFooter}</Footnote>}>
        <FontRow id="ai.fontName" proportional />
        <SliderRow id="ai.fontSize" step={1} digits={[0, 0]} />
      </Section>
    </>
  );
}

function HelpPane() {
  return (
    <Section title={s.helpMenu} footer={<Footnote>{settingsWords.help.footer}</Footnote>}>
      <MenuRow id="help.outputDestination" options={[0, 1, 2]} />
    </Section>
  );
}

/** LLMProvider (LLMBackend.swift): defaults and the curated lists the row menus offer. */
export const PROVIDERS = {
  // The cloud providers' models come from src/panes/ai/catalog.ts (2.1: dated, merged with Refresh).
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true, urls: ["https://api.anthropic.com"], models: [] as string[] },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-6-astra", needsKey: true, urls: ["https://api.openai.com/v1"], models: [] as string[] },
  ollama: { baseURL: "http://localhost:11434", model: "llama3.2", needsKey: false, urls: ["http://localhost:11434", "http://127.0.0.1:11434"], models: ["llama3.1:8b", "llama3.1:70b", "llama3.2", "llama3.3:70b", "qwen2.5:7b", "qwen2.5:14b", "qwen2.5:32b", "mistral-nemo"] },
  lmstudio: { baseURL: "http://localhost:1234/v1", model: "local-model", needsKey: false, urls: ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1"], models: ["llama-3.1-8b-instruct", "llama-3.3-70b-instruct", "qwen2.5-7b-instruct", "qwen2.5-14b-instruct", "mistral-nemo-instruct-2407"] },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function currentProvider(values: Record<string, unknown>): ProviderId {
  const p = values["ai.provider"];
  return typeof p === "string" && p in PROVIDERS ? (p as ProviderId) : "anthropic";
}

function AIAssistantPane() {
  const c = useSettingsCtx();
  const t = settingsWords.ai;
  const p = currentProvider(c.values);
  const info = PROVIDERS[p];
  const discovered = String(c.values[`ai.discovered.${p}`] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  // A stored model Anthropic has retired or deprecated: a note, never a silent change (2.1).
  const storedModel = String(c.values[`ai.model.${p}`] ?? "");
  const facts = modelAdvice(p, storedModel);
  const advice = !facts ? null : facts.kind === "retired" ? t.retiredNote(storedModel, facts.replacement) : t.deprecatedNote(storedModel, facts.retires ?? "", facts.replacement);
  const [prompt, setPrompt] = useState(String(c.values["ai.systemPrompt"] ?? ""));
  useEffect(() => setPrompt(String(c.values["ai.systemPrompt"] ?? "")), [c.values["ai.systemPrompt"]]);
  return (
    <>
      <Section title={s.pane} footer={<Footnote>{t.paneFooter}</Footnote>}>
        <ToggleRow id="ai.paneVisible" />
      </Section>
      <Section title={s.backend}>
        <MenuRow id="ai.provider" options={PROVIDER_IDS} />
        <Row
          id="ai.baseURL"
          caption={t.providerHint[p]}
          control={
            <TextField
              k={`ai.baseURL.${p}`}
              label={w("ai.baseURL").label}
              placeholder={info.baseURL}
              after={
                <IconMenu
                  label={t.endpoints}
                  help={t.endpointsTip}
                  icon={<Icon icon={List} size={14} />}
                  sections={[{ items: info.urls.map((u) => ({ label: u, value: u })) }, { items: [{ label: t.resetTo(info.baseURL), value: info.baseURL }] }]}
                  onPick={(u) => void c.set({ [`ai.baseURL.${p}`]: u })}
                />
              }
            />
          }
        />
        <Row
          id="ai.model"
          messages={advice ? [{ text: advice, severity: "warning" }] : undefined}
          control={
            <TextField
              k={`ai.model.${p}`}
              label={w("ai.model").label}
              placeholder={info.model}
              after={
                <>
                  <IconMenu
                    label={t.models}
                    help={t.modelsTip}
                    icon={<Icon icon={List} size={14} />}
                    sections={[
                      ...(CATALOG[p]
                        ? pickerSections(p, discovered, { current: t.currentModels(CATALOG_DATE), older: t.olderModels, account: t.accountModels, deprecated: t.deprecatedModel })
                        : [
                            ...(discovered.length ? [{ title: t.fromServer, items: discovered.map((m) => ({ label: m, value: m })) }] : []),
                            { title: t.recommended, items: info.models.map((m) => ({ label: m, value: m })) },
                          ]),
                      { items: [{ label: t.resetTo(info.model), value: info.model }] },
                    ]}
                    onPick={(m) => void c.set({ [`ai.model.${p}`]: m })}
                  />
                  <AiModelRefresh provider={p} />
                </>
              }
            />
          }
        />
        {info.needsKey ? (
          <Row
            id="ai.apiKey"
            control={
              <AiKeyField provider={p} />
            }
          />
        ) : (
          <Row id="ai.apiKey" caption={t.localKeyCaption} control={<span className="set-readonly">{t.notRequired}</span>} />
        )}
      </Section>
      <Section title={s.generation}>
        <Row
          id="ai.systemPrompt"
          control={
            <textarea
              className="set-textarea mono"
              aria-label={w("ai.systemPrompt").label}
              title={w("ai.systemPrompt").help}
              value={prompt}
              rows={4}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt !== c.values["ai.systemPrompt"] && void c.set({ "ai.systemPrompt": prompt })}
            />
          }
        />
        <NumberRow id="ai.maxTokens" int step={256} />
        <SliderRow id="ai.temperature" step={0.05} digits={[2, 2]} />
        {p === "anthropic" ? <ToggleRow id="ai.fallback.anthropic" /> : null}
        <NumberRow id="ai.timeoutSec" int={false} step={5} digits={[0, 0]} />
      </Section>
      <Section title={s.connection} footer={<Footnote>{t.connectionFooter}</Footnote>}>
        <Row
          id="ai.testConnection"
          control={
            <AiTestConnection provider={p} />
          }
        />
      </Section>
    </>
  );
}

/** The rows of `pane`. */
export function PaneBody({ pane }: { pane: PaneId }) {
  switch (pane) {
    case "General": return <GeneralPane />;
    case "Solver Engine": return <SolverEnginePane />;
    case "Simulation": return <SimulationPane />;
    case "SRBM MLMC": return <ExactSimulationPane />;
    case "Linear Program": return <LinearProgramPane />;
    case "Finite-Buffer LP": return <FiniteLPPane />;
    case "Finite Element": return <FiniteElementPane />;
    case "Spectral Method": return <SpectralPane />;
    case "Test Sets": return <TestSetsPane />;
    case "Output Format": return <OutputFormatPane />;
    case "Interactive Shell Window": return <AppearancePane />;
    case "Help menu": return <HelpPane />;
    case "AI Assistant": return <AIAssistantPane />;
  }
}
