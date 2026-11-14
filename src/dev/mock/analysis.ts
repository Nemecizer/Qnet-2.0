// The analysis area's commands in the browser preview and the tests
// (src-tauri/src/analysis_windows/). The preview can't run core, so for a shipped example (known
// by its nodes and links) it answers from what 0.90.34 itself produced, in golden/<example>/:
//
// - analysis_report: analysis.txt / primitives.txt with 2.0's two Changed sentences (ANA-154's
//   "~10%." and ANA-180's μ legend), and Status lines rebuilt from dump-rho.txt's numbers.
//   Primitives' flags are the status mock's analysis (`mockAnalysis.run`).
// - analysis_report_show: the run path's messages, `output` then `finished`; refused, with the
//   registry's sentence, while the runs mock reports an active run.
// - method_domain: the network's structure from the document, its flags from flags.txt and
//   primitives.txt, and the exporters' verdicts from product-form.json / qbd.json(.error.txt).
// - method_availability, dependency_catalog, dependency_probe: everything installed, a source
//   tree; tests change `mockAnalysisWindows`.
// Any other network gets a stand-in sentence.
import type { BnetDocument } from "../../lib/bnet";
import type { DependencyCatalog, DependencyResult, MethodDomain, PreparedReport, RunMessage, RuntimeAvailability, RuntimeKey } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import { mockAnalysis } from "./status";
import { mockDisplayLabel } from "./runs";

const raw = (g: Record<string, unknown>) => g as Record<string, () => Promise<string>>;
/** 0.90.34's re-save of each example: the document as Rust's reader hands it to the page. */
const examples = raw(import.meta.glob("../../../golden/*/resave.bnet", { query: "?raw", import: "default" }));
const golden = raw(
  import.meta.glob("../../../golden/*/{analysis.txt,primitives.txt,dump-rho.txt,flags.txt,product-form.json.error.txt,qbd.json.error.txt}", { query: "?raw", import: "default" }),
);

const RUNTIMES: RuntimeKey[] = ["productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds", "multiclass", "genericCtmc", "decomposition"];
// A source-tree run's rows (deps.rs `requirements(false)`): what a developer needs to build the
// solvers. A packaged app's rows are all Bundled, with no command; tests set that catalog.
const CATALOG_DEV = ["developer.xcode-tools", "developer.cmake", "runtime.python", "optional.numpy", "optional.cvxpy", "developer.solver-libraries"];
const SCOPE: Record<string, DependencyCatalog["items"][number]["scope"]> = { developer: "Developer", runtime: "Runtime", optional: "Optional", bundled: "Bundled" };
const FORMULAE: Record<string, string[]> = { "developer.cmake": ["cmake"], "runtime.python": ["python"], "optional.numpy": ["numpy"] };
const COMMANDS: Record<string, string[]> = {
  "developer.xcode-tools": ["xcode-select --install"],
  "optional.cvxpy": ["python3 -m pip install cvxpy"],
  "developer.solver-libraries": ["bash scripts/build-deps.sh"],
};

/** What the preview reports; tests change it (each handler table starts from these defaults). */
const defaults = () => ({
  availability: RUNTIMES.map((key) => ({ key, available: true, reason: null })) as RuntimeAvailability[],
  catalog: {
    packaged: false,
    items: CATALOG_DEV.map((id) => ({
      id,
      scope: SCOPE[id.split(".")[0]],
      brewFormulae: FORMULAE[id] ?? [],
      supplementalInstallCommands: COMMANDS[id] ?? [],
    })),
  } as DependencyCatalog,
  probe: (id: string): DependencyResult => ({ state: "available", detail: id === "runtime.python" ? "Python 3.12.4" : "Ready (browser preview)" }),
  /** Every report shown, in order. */
  shown: [] as { tabId: string; kind: string; report: string }[],
});

export const mockAnalysisWindows = defaults();

let exampleIndex: Map<string, string> | null = null;

/** What tells the examples apart (several share node ids): ids, names, links, buffer mode. */
const signature = (d: BnetDocument) => JSON.stringify([!!d.infiniteBuffers, d.nodes.map((n) => [n.id, n.name, n.distributionParameters]), d.links.map((l) => [l.id, l.routingProbability])]);

/** The example a document is, or null. */
async function exampleOf(doc: BnetDocument): Promise<string | null> {
  if (!exampleIndex) {
    exampleIndex = new Map();
    for (const [path, load] of Object.entries(examples)) {
      try {
        const d = JSON.parse(await load()) as BnetDocument;
        if (d.nodes) exampleIndex.set(signature(d), path.replace(/^.*\/golden\//, "").replace(/\/resave\.bnet$/, ""));
      } catch {
        // Not a network.
      }
    }
  }
  return doc.nodes ? (exampleIndex.get(signature(doc)) ?? null) : null;
}

async function goldenFile(example: string, file: string): Promise<string | null> {
  const load = golden[`../../../golden/${example}/${file}`];
  return load ? load() : null;
}

/** 2.0's text: 0.90.34's with the two Changed sentences. */
function as2(text: string): string {
  return text
    .replace(/usually within ~10$/gm, "usually within ~10%.")
    .replace("  μ_i = Σ_k (α^(k)_i/α_i) μ^(k)_i     throughput-weighted service rate\n", "  μ_i = 1 / Σ_k (α^(k)_i/α_i) (1/μ^(k)_i)     throughput-weighted (harmonic) service rate\n");
}

const f = (x: number, places: number) => (Number.isFinite(x) ? x.toFixed(places) : "nan");

/** The Status lines, from --dump-rho's six-place numbers. */
function statusFrom(dump: string, kind: string): string[] {
  const stations = [...dump.matchAll(/^S(\d+): α=(\S+)\s+μ_eff=(\S+)\s+c=(\S+)\s+ρ=(\S+)/gm)].map((m) => ({ i: m[1], a: Number(m[2]), mu: Number(m[3]), c: Number(m[4]), rho: Number(m[5]) }));
  if (kind === "analyze") return [`Analyze Network ρ (data.alpha/data.capacity):${stations.map((s) => `  S${s.i} α=${f(s.a, 4)} c=${f(s.c, 4)} ρ=${f(s.rho, 4)}`).join("")}`];
  const lines = [`Primitives ρ:${stations.map((s) => `  S${s.i}[α=${f(s.a, 4)},μ=${f(s.mu, 4)},ρ=${f(s.rho, 4)}]`).join("")}`];
  for (const m of dump.matchAll(/^class (\d+): α=\[([^\]]*)\]\s+μ=\[([^\]]*)\]/gm)) {
    const a = m[2].trim().split(/\s+/).map(Number);
    const mu = m[3].trim().split(/\s+/).map(Number);
    lines.push(`  class ${m[1]} α·μ per station:${a.map((x, i) => `  [${f(x, 3)}/${f(mu[i], 3)}]`).join("")}`);
  }
  return lines;
}

function flag(flags: string, key: string): string {
  return new RegExp(`^${key}=(.*)$`, "m").exec(flags)?.[1] ?? "";
}

function section(flags: string, key: string): string {
  const m = new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[a-zA-Z]+[:=]|$(?![\\s\\S]))`, "m").exec(flags);
  return (m?.[1] ?? "").replace(/\n+$/, "");
}

const exitClass = (l: BnetDocument["links"][number]) => l.toCustomerClass ?? l.customerClass;

function rateOf(params: string): number | null {
  for (const pair of params.split(",")) {
    const [k, v] = pair.split("=").map((x) => x?.trim());
    if (k === "rate" && v !== undefined && v !== "") return Number(v);
  }
  return null;
}

/** The structural half of `MethodDomain`, from the document (the Rust port's rules). */
function structure(doc: BnetDocument) {
  const stations = doc.nodes.filter((n) => n.kind === "station");
  const sources = doc.nodes.filter((n) => n.kind === "source");
  const classIds = new Set<number>(doc.links.flatMap((l) => [l.customerClass, exitClass(l)]));
  stations.forEach((s) => Object.keys(s.serviceDistributions ?? {}).forEach((k) => classIds.add(Number(k))));
  const classes = new Set<number>(doc.links.flatMap((l) => [l.customerClass, exitClass(l)]));
  // The preview takes sources in document order (core sorts them by their names' numbers).
  sources.forEach((_s, i) => classes.add(i));
  if (!classes.size) classes.add(0);
  const independent = stations.every((s) => {
    const rates = [...classes].map((c) => {
      const cfg = s.serviceDistributions?.[String(c)] ?? { distribution: s.distribution, distributionParameters: s.distributionParameters };
      return cfg.distribution === "exponential" ? rateOf(cfg.distributionParameters) : null;
    });
    if (rates.some((r) => r === null)) return false;
    const first = rates[0]!;
    return Number.isFinite(first) && first > 0 && rates.every((r) => Number.isFinite(r!) && r! > 0 && Math.abs(r! - first) <= 1e-10 * Math.max(1, Math.abs(first), Math.abs(r!)));
  });
  return {
    infiniteBuffers: doc.infiniteBuffers,
    stationCount: stations.length,
    classCount: Math.max(classIds.size, 1),
    sourcesArePoisson: sources.every((s) => s.distribution === "poisson" || s.distribution === "exponential"),
    servicesAreExponential: stations.every((s) => s.distribution === "exponential" && Object.values(s.serviceDistributions ?? {}).every((c) => c.distribution === "exponential")),
    classTransitions: doc.links.some((l) => l.toCustomerClass !== undefined && l.toCustomerClass !== l.customerClass),
    classIndependentService: independent,
  };
}

export function analysisWindowHandlers(): MockHandlers {
  Object.assign(mockAnalysisWindows, defaults());
  return {
    analysis_report: async ({ document, kind }: { document: BnetDocument; kind: "analyze" | "primitives" }): Promise<PreparedReport> => {
      const example = await exampleOf(document);
      const text = example ? await goldenFile(example, kind === "analyze" ? "analysis.txt" : "primitives.txt") : null;
      const dump = example ? await goldenFile(example, "dump-rho.txt") : null;
      const analysis = kind === "primitives" ? mockAnalysis.run(document) : null;
      if (text === null) {
        return { failed: null, status: [], report: "The browser preview has no recorded report for this network.\n", analysis };
      }
      return { failed: null, status: dump ? statusFrom(dump, kind) : [], report: as2(text), analysis };
    },
    analysis_report_show: async ({ request, channel }: { request: { tabId: string; title: string; kind: string; report: string }; channel: unknown }) => {
      const send = (m: RunMessage) => channelSend(channel, m);
      const label = mockDisplayLabel(request.kind);
      // The one run slot is the runs mock's: ask it, as the registry would.
      const { invoke } = await import("@tauri-apps/api/core");
      const active = (await invoke("run_active").catch(() => null)) as { displayLabel: string; tabTitle: string } | null;
      if (active) {
        send({ kind: "status", text: `${label} was not started because ${active.displayLabel} is already running for “${active.tabTitle}”. Stop or wait for that run first.`, severity: "warning" });
        return { started: false };
      }
      mockAnalysisWindows.shown.push({ tabId: request.tabId, kind: request.kind, report: request.report });
      setTimeout(() => {
        const bytes = new TextEncoder().encode(request.report);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        send({ kind: "output", data: btoa(bin) });
        const summary = `${label} finished in 0.0 s`;
        send({ kind: "finished", summary, statusBar: `${summary} · ${request.title}`, exitCode: 0, userStopped: false, succeeded: true, recordId: null, filed: null, filedReason: null });
      }, 0);
      return { started: true };
    },
    method_domain: async ({ document }: { document: BnetDocument }): Promise<MethodDomain> => {
      const s = structure(document);
      const example = await exampleOf(document);
      const flags = example ? ((await goldenFile(example, "flags.txt")) ?? "") : "";
      const primitives = example ? ((await goldenFile(example, "primitives.txt")) ?? "") : "";
      const tractable = flag(flags, "isAnalyticallyTractable") === "true";
      const exact = flag(flags, "tractabilityIsExact") === "true";
      const means = flag(flags, "tractabilityMeans").split(/\s+/).filter(Boolean).map(Number);
      const refusal = async (file: string) => (example ? ((await goldenFile(example, file))?.replace(/\n$/, "") ?? null) : "The browser preview has no recorded verdict for this network.");
      return {
        ...s,
        warningCount: (primitives.match(/!! Warning:/g) ?? []).length,
        hasFeedback: flag(flags, "hasFeedback") === "true",
        analytical: tractable ? { exact, title: flag(flags, "tractabilityTitle"), detail: flag(flags, "tractabilityDetail"), explanation: section(flags, "tractabilityExplanation") } : null,
        heavyJackson: exact && /jackson/i.test(flag(flags, "tractabilityMeansLabel")) && means.reduce((a, b) => a + b, 0) > 20,
        productFormRefusal: await refusal("product-form.json.error.txt"),
        qbdRefusal: await refusal("qbd.json.error.txt"),
        // Preview only: the browser has no simulator and no recorded run of Replicated Simulation
        // for an open network, so the stand-in says so rather than offer a run it cannot make.
        // (In the app this is core's `simstat::plan`. Closed networks: ./closed.ts.)
        replicatedSimulationRefusal: s.infiniteBuffers ? "The browser preview cannot run Replicated Simulation on an open network (it has no simulator); the app can." : "Replicated Simulation covers infinite buffers. With finite buffers what happens at a full buffer depends on a blocking rule (loss, or blocking after service) that is chosen for each run and is not part of the network. Use Monte Carlo for a finite-buffer network: it asks for the rule.",
      };
    },
    method_availability: () => mockAnalysisWindows.availability,
    dependency_catalog: () => mockAnalysisWindows.catalog,
    dependency_probe: ({ id }: { id: string }) => mockAnalysisWindows.probe(id),
  };
}
