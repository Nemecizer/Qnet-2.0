// The explaining assistant without a network (ledger WF-401…WF-410): the real loop, tools, ledger
// and verifier against the scripted provider (src/dev/mock/ai.ts) and the preview's stand-in
// backend. The well-behaved transcripts are played by the scripted model (src/dev/mock/aiExplain.ts),
// which writes only from the tools' fact lines; the badly-behaved ones are scripted by hand. No
// provider is called and no key is read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { example } from "../../../canvas/layers/testkit";
import { defaultHandlers } from "../../../dev/mockBackend";
import { mockAi } from "../../../dev/mock/ai";
import { explainModel, readFacts } from "../../../dev/mock/aiExplain";
import { mockRuns } from "../../../dev/mock/runs";
import { mockQuietRecord } from "../../../dev/mock/sweeps2";
import { editorFor } from "../../../editor";
import { api } from "../../../lib/api";
import type { BnetDocument } from "../../../lib/bnet";
import { loadKv, resetKv } from "../../../lib/kv";
import { holdModal, resetOverlays } from "../../../lib/overlays";
import type { AiChatRequest, AiEvent } from "../../../lib/types";
import { AGREE, CLOSE } from "../../../results/insight";
import { resetStructures } from "../../../results/current";
import { resetRuns } from "../../../runs/state";
import { mockTauri } from "../../../test/tauri";
import { specItem } from "../../../lib/menuSpec";
import type { SensitivityResult } from "../../../sensitivity/model";
import { setSensitivityEstimate } from "../../../sensitivity/store";
import { addTab, tabById } from "../../../workspace/store";
import { resetAdvice } from "../../results/agreement/chooser";
import { resetAgreementCommands } from "../../results/agreement/commands";
import { resetSequence } from "../../results/agreement/runner";
import { extendedExampleFiles } from "../../../dev/mock/documents";
import { conversationOf, resetAi, submit, whenIdle } from "../model";
import { call, textTurn, toolTurn } from "../testing";
import { executeTool, toolSpecs, type ToolContext } from "../tools";
import { aiWords as w } from "../words";
import { factsOf, HANDLE, MAX_FACTS, MAX_RESULT_CHARS } from "./facts";
import { EXPLAIN_PROMPT, EXPLAIN_TOOL_TEXT } from "./prompt";
import { ACTION_TOOLS, EXPLAIN_SPECS, EXPLAIN_WAIT, HELP_PART_CHARS, READ_TOOLS, setConfirmer, type Question } from "./tools";

const JACKSON = "OpenJackson.d2.feedback.p30.inf.bnet";
const closedFiles = import.meta.glob("../../../../examples/closed/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const closed = (): BnetDocument => JSON.parse(Object.values(closedFiles)[0]) as BnetDocument;
const withRate = (doc: BnetDocument, station: string, rate: number): BnetDocument => ({ ...doc, nodes: doc.nodes.map((n) => (n.name === station ? { ...n, distributionParameters: `rate=${rate}` } : n)) });

let tabId: string;
const ctx = (id = tabId): ToolContext => ({ tabId: id, editor: editorFor(id), cancelled: () => false });
const run = (name: string, input: Record<string, unknown> = {}, id = tabId) => executeTool(name, input, ctx(id));
const open = (doc: BnetDocument, title = JACKSON) => (tabId = addTab({ title, document: doc }));

/** Files a finished run of `method` for the tab's network as it is now. */
async function record(method: string, id = tabId) {
  const tab = tabById(id)!;
  const r = mockQuietRecord({ tabId: id, title: tab.title, method }, tab.document) as unknown as { provenance: { networkFingerprint: string } };
  r.provenance.networkFingerprint = await api.resultsFingerprint(tab.document);
  mockRuns.records.push(r as never);
}

/** A scripted model: `first` on the question, then `answer` written from the tool results. */
function model(first: AiEvent[], answer: (results: string) => string) {
  mockAi.responder = (request: AiChatRequest) => {
    const at = request.messages.map((m) => m.role).lastIndexOf("user");
    const results = request.messages.slice(at + 1).flatMap((m) => (m.role === "tool" ? m.results : []));
    return results.length ? textTurn(answer(results.map((r) => r.content).join("\n"))) : first;
  };
}
const ask = async (question: string) => {
  expect(submit(tabId, question)).toBe(true);
  await whenIdle();
  return conversationOf(tabId).messages;
};
const lastAnswer = () => conversationOf(tabId).messages.filter((m) => m.role === "assistant").at(-1)!;
const toolRows = () => conversationOf(tabId).messages.filter((m) => m.call).map((m) => m.call!);
const handlesIn = (text: string) => [...text.matchAll(new RegExp(HANDLE.source, "g"))].map((m) => m[1]);

beforeEach(async () => {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "ollama" } }));
  mockRuns.replayMs = 2;
  EXPLAIN_WAIT.intervalMs = 5;
  resetKv();
  resetRuns();
  resetStructures();
  resetAdvice();
  resetAgreementCommands();
  resetSequence();
  resetOverlays();
  await loadKv();
  open(example(JACKSON));
});
afterEach(() => {
  resetAi();
  setConfirmer(null);
  EXPLAIN_WAIT.intervalMs = 200;
  mockRuns.replayMs = 120;
});

describe("the tools' schemas", () => {
  it("every explaining tool has a description a small model can read and an object schema whose required arguments exist", () => {
    expect(EXPLAIN_SPECS.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...ACTION_TOOLS].sort());
    for (const t of EXPLAIN_SPECS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.description.length, t.name).toBeLessThan(700);
      const schema = t.inputSchema as { type: string; properties: Record<string, { type?: unknown; description?: string }>; required: string[] };
      expect(schema.type).toBe("object");
      for (const r of schema.required) expect(Object.keys(schema.properties), `${t.name}.${r}`).toContain(r);
      for (const [k, p] of Object.entries(schema.properties)) expect(typeof p.description, `${t.name}.${k}`).toBe("string");
    }
    // The reading tools say they change nothing where a model might fear they do; the acting ones say what they start.
    for (const name of ["solve", "check_with_another_method", "run_sweep"]) expect(EXPLAIN_TOOL_TEXT[name as "solve"]).toMatch(/starts .*solver run/);
    for (const name of ["run_sweep", "apply_capacity_plan"]) expect(EXPLAIN_TOOL_TEXT[name as "solve"]).toMatch(/asks the person to confirm first/);
    expect(toolSpecs()).toHaveLength(9 + EXPLAIN_SPECS.length);
    // The verdict thresholds the model is told are the ones the Agreement view uses.
    expect([AGREE, CLOSE]).toEqual([0.02, 0.1]);
    expect(EXPLAIN_TOOL_TEXT.verdicts).toContain("within 2 %");
    expect(EXPLAIN_TOOL_TEXT.verdicts).toContain("within 10 %");
  });

  it("the prompt asks for a handle after every number, 'I don't know', the tier, exact before approximate, and an offer to Solve", () => {
    for (const phrase of ["Never write a number you did not get from a tool", "right AFTER every number", "I don't know", "Always say the tier", "Prefer exact over simulation", "offer to run Solve", "get_help, not from memory", "what was NOT checked"]) expect(EXPLAIN_PROMPT).toContain(phrase);
    expect(EXPLAIN_PROMPT.length).toBeLessThan(4500);
  });
});

describe("the reading tools", () => {
  it("every result is bounded, and every handle it shows is in the conversation's ledger with a unit and a tier", async () => {
    await record("product_form");
    await record("qna");
    const calls: [string, Record<string, unknown>][] = [
      ["get_results", {}], ["get_agreement", {}], ["get_live_results", {}], ["get_problems", {}], ["get_parameters", {}],
      ["get_sensitivity", { measure: "network_delay", target_change_percent: -10 }], ["get_sensitivity", { measure: "station_utilisation", station: "S2" }],
      ["plan_capacity", { target: "utilisation_percent", value: 60 }], ["get_uncertainty", { measure: "network_delay", percent: 5 }],
      ["get_transient", {}], ["list_methods", {}], ["get_help", { topic: "qna" }],
    ];
    expect(new Set(calls.map(([n]) => n))).toEqual(READ_TOOLS);
    const before = JSON.stringify(tabById(tabId)!.document);
    for (const [name, input] of calls) {
      const text = await run(name, input);
      expect(text.length, name).toBeLessThanOrEqual(Math.max(MAX_RESULT_CHARS, HELP_PART_CHARS + 600) + 200);
      const handles = handlesIn(text);
      expect(handles.length, name).toBeLessThanOrEqual(MAX_FACTS + 1);
      if (name !== "list_methods" && name !== "get_problems") expect(handles.length, `${name}: ${text}`).toBeGreaterThan(0);
      for (const h of handles) {
        const f = factsOf(tabId).get(h);
        expect(f, `${name} ${h}`).toBeDefined();
        if (f?.kind === "number") {
          expect(Number.isFinite(f.value)).toBe(true);
          expect(f.tier).not.toBe("");
          expect(typeof f.unit).toBe("string");
        }
      }
    }
    // Reading changes nothing and starts nothing.
    expect(JSON.stringify(tabById(tabId)!.document)).toBe(before);
    expect(mockRuns.starts).toHaveLength(0);
    expect(tabById(tabId)!.log).toHaveLength(0);
  });

  it("get_results reads the current runs through the shared reading: tiers best first, the bottleneck, stale runs left out", async () => {
    await record("qna");
    await record("product_form");
    const text = await run("get_results");
    expect(text.indexOf("tier: exact")).toBeGreaterThan(0);
    expect(text.indexOf("tier: exact")).toBeLessThan(text.indexOf("tier: approximation"));
    expect(text).toMatch(/Bottleneck \(highest utilisation\): S\d/);
    const facts = readFacts(text);
    expect(facts.some((f) => /^run:[0-9a-f]{8}:S1:utilisation$/.test(f.handle) && f.tier === "exact")).toBe(true);
    expect(facts.find((f) => /:S1:utilisation$/.test(f.handle))!.value).toMatch(/^0\.\d+$/);
    expect(await run("get_results", { station: "S2" })).not.toContain(":S1:");
    await expect(run("get_results", { station: "S9" })).rejects.toThrow('Invalid tool input: No station named "S9". Stations: S1, S2.');
    // The network changes: those runs no longer apply, and the tool says so rather than quote them.
    editorFor(tabId).updateNodeDistribution(editorFor(tabId).nodes.find((n) => n.name === "S1")!.id, "exponential", "rate=3.0");
    const after = await run("get_results");
    expect(after).toContain("No results: no method has been run on the network as it is now. (2 earlier results are of an older version of the network and no longer apply.)");
    expect(after).toContain("offer to run Solve");
    expect(handlesIn(after)).toEqual([]);
  });

  it("a large network's results are cut to the limit, say so, and only what was shown can be cited", async () => {
    const base = example(JACKSON);
    const s1 = base.nodes.find((n) => n.name === "S1")!;
    const b1 = base.nodes.find((n) => n.name === "B1")!;
    const extra = Array.from({ length: 40 }, (_, i) => [{ ...b1, id: `B-${i}`, name: `XB${i}` }, { ...s1, id: `S-${i}`, name: `X${i}`, distributionParameters: "rate=9" }]).flat();
    const links = extra.filter((n) => n.kind === "station").flatMap((s, i) => [
      { ...base.links[0], id: `L-a${i}`, fromNodeID: base.nodes.find((n) => n.kind === "source")!.id, toNodeID: `B-${i}`, routingProbability: 0.01 },
      { ...base.links[0], id: `L-b${i}`, fromNodeID: `B-${i}`, toNodeID: s.id, routingProbability: 1 },
      { ...base.links[0], id: `L-c${i}`, fromNodeID: s.id, toNodeID: base.nodes.find((n) => n.kind === "sink")!.id, routingProbability: 1 },
    ]);
    open({ ...base, nodes: [...base.nodes, ...extra], links: [...base.links, ...links] }, "big.bnet");
    await record("qna");
    const text = await run("get_results");
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(handlesIn(text).length).toBeLessThanOrEqual(MAX_FACTS);
    expect(text).toMatch(/more numbers were left out to keep this short\. Ask again with `station` for one station\.|The rest was cut to keep this short/);
    expect(factsOf(tabId).size).toBe(new Set(handlesIn(text)).size);
  });

  it("get_help hands over Qnet's own article, in parts, and says so when there is none", async () => {
    const text = await run("get_help", { topic: "qna" });
    expect(text).toMatch(/^\[help:qna\] Qnet Help — /);
    expect(text).toContain("put [help:qna] after what you take from it");
    const byTitle = await run("get_help", { topic: "sensitivity" });
    expect(byTitle).toMatch(/^\[help:sensitivity\]/);
    const none = await run("get_help", { topic: "zzz no such thing" });
    expect(none).toContain("Say you don't know rather than explain it from memory");
    expect(handlesIn(none)).toEqual([]);
    const f = factsOf(tabId).get("help:qna");
    expect(f?.kind === "text" && f.text.length).toBeGreaterThan(500);
  });
});

describe("the verifier in the transcript", () => {
  it("a fabricated number is flagged, the cited ones are not", async () => {
    await record("product_form");
    model(toolTurn(call("get_results")), (r) => {
      const rho = readFacts(r).find((f) => /:S1:utilisation$/.test(f.handle))!;
      return `S1 is busy ${rho.value} [${rho.handle}] of the time (exact). Customers wait 12.7 time units there.`;
    });
    await ask("Explain this result");
    const check = lastAnswer().check!;
    expect(check.numbers.map((n) => n.status)).toEqual(["verified", "unverified"]);
    expect(check.flagged.map((f) => f.text)).toEqual(["12.7"]);
  });

  it("a number under the wrong unit is flagged", async () => {
    await record("product_form");
    model(toolTurn(call("get_results")), (r) => {
      const rho = readFacts(r).find((f) => /:S1:utilisation$/.test(f.handle))!;
      return `There are ${rho.value} customers [${rho.handle}] at S1, that is ${rho.value} % [${rho.handle}].`;
    });
    await ask("Explain this result");
    expect(lastAnswer().check!.flagged.map((f) => f.status)).toEqual(["unit", "mismatch"]);
  });

  it("a citation of a run that no longer applies is flagged: the network changed after it was read", async () => {
    await record("product_form");
    let cited = "";
    mockAi.responder = (request) => {
      const results = request.messages.flatMap((m) => (m.role === "tool" ? m.results : []));
      if (!results.length) return toolTurn(call("get_results"));
      if (results.length === 1) return toolTurn(call("update_node", { name: "S1", distribution_parameters: "rate=3.0" }));
      const rho = readFacts(results[0].content).find((f) => /:S1:utilisation$/.test(f.handle))!;
      cited = rho.handle;
      return textTurn(`I made S1 faster. Its utilisation is ${rho.value} [${rho.handle}].`);
    };
    await ask("Speed up S1 and tell me its utilisation");
    const check = lastAnswer().check!;
    expect(check.flagged).toHaveLength(1);
    expect(check.flagged[0]).toMatchObject({ status: "stale", handle: cited });
    expect(check.handles[0].status).toBe("stale");
    // The rate it set itself is an input, not a result.
    expect(check.numbers.some((n) => n.status === "input")).toBe(false);
  });

  it("the export says which numbers were unverified", async () => {
    model(toolTurn(call("get_live_results")), () => "The delay is 9.99 time units.");
    await ask("What is the delay?");
    const { transcriptMarkdown } = await import("../transcript");
    expect(transcriptMarkdown(conversationOf(tabId).messages)).toContain(`> _${w.checkExport(["9.99"])}_`);
  });
});

describe("explaining", () => {
  it("why a station is the bottleneck, from live results and sensitivity, with every number cited", async () => {
    open(withRate(example(JACKSON), "S2", 1.2), "slower.bnet");
    mockAi.responder = explainModel;
    await ask(w.starters.bottleneck("S2"));
    expect(toolRows().map((c) => c.name)).toEqual(["get_live_results", "get_sensitivity"]);
    expect(toolRows().every((c) => !c.isError)).toBe(true);
    const answer = lastAnswer();
    const live = toolRows()[0].result!;
    const top = /^Bottleneck \(highest ρ\): (\S+)\./m.exec(live)![1];
    expect(answer.text).toContain(`${top} is the bottleneck because it has the highest utilisation`);
    const handles = handlesIn(answer.text);
    expect(handles[0]).toBe(`live:${top}:rho`);
    expect(handles[1]).toMatch(/^sens:delay:(mu|lambda|servers|p)_/);
    // The parameter it names is the one with the largest elasticity in the tool's answer.
    const elasticities = readFacts(toolRows()[1].result!).filter((f) => /^Elasticity/.test(f.what));
    const largest = [...elasticities].sort((a, b) => Math.abs(Number(b.value)) - Math.abs(Number(a.value)))[0];
    expect(handles[1]).toBe(largest.handle);
    expect(answer.text).toMatch(/tier: exact/);
    expect(answer.check!.flagged).toEqual([]);
    expect(answer.check!.numbers.map((n) => n.status)).toEqual(["verified", "verified"]);
    expect(answer.check!.handles.every((h) => h.status === "known")).toBe(true);
  });

  it("a tie is said to be a tie, with both utilisations cited", async () => {
    mockAi.responder = explainModel;
    await ask(w.starters.bottleneck("S2"));
    expect(lastAnswer().text).toMatch(/^There is no single bottleneck: S1 and S2 tie for the highest utilisation — 0\.7 \[live:S1:rho\] and 0\.7 \[live:S2:rho\] \(tier: exact\)\./);
    expect(lastAnswer().check!.flagged).toEqual([]);
  });

  it("no results yet: it offers to Solve and states no number; nothing is run", async () => {
    mockAi.responder = explainModel;
    await ask(w.starters.explain);
    expect(toolRows().map((c) => c.name)).toEqual(["get_results", "get_agreement"]);
    expect(toolRows()[0].result).toMatch(/^No results: no method has been run on the network as it is now\./);
    const answer = lastAnswer();
    expect(answer.text).toBe("Nothing has been solved for this network yet, so I have no numbers to give you. Shall I run Solve?");
    expect(answer.check!.numbers).toEqual([]);
    expect(mockRuns.starts).toHaveLength(0);
  });

  it("a result, how sure it is and a methods paragraph are written from the runs, the agreement and the parameters", async () => {
    await record("product_form");
    await record("qna");
    mockAi.responder = explainModel;
    await ask(w.starters.explain);
    expect(lastAnswer().check!.flagged).toEqual([]);
    expect(lastAnswer().check!.numbers.length).toBeGreaterThan(3);
    await ask(w.starters.sure);
    expect(lastAnswer().text).toMatch(/^Methods compared: verdict “(agree|close|disagree)”\./);
    expect(lastAnswer().check!.flagged).toEqual([]);
    await ask(w.starters.methods);
    const methods = lastAnswer();
    expect(toolRows().slice(-3).map((c) => c.name)).toEqual(["get_parameters", "get_results", "get_agreement"]);
    expect(methods.text).toMatch(/analysed with Qnet \d+\.\d+\.\d+ \[app:version\]/);
    expect(methods.text).toContain("Exact Open Product Form (exact) and Whitt QNA (approximation)");
    expect(methods.text).toContain("**Not checked.**");
    expect(handlesIn(methods.text).filter((h) => h.startsWith("net:")).length).toBeGreaterThan(2);
    expect(methods.check!.flagged).toEqual([]);
  });

  it("a method is explained from Qnet's Help, not from memory", async () => {
    mockAi.responder = explainModel;
    await ask(w.starters.method("Whitt QNA"));
    expect(toolRows().map((c) => c.name)).toEqual(["list_methods", "get_help"]);
    expect(lastAnswer().text).toMatch(/^From Qnet's Help \[help:\w+\]: /);
    expect(lastAnswer().check!.handles[0].status).toBe("known");
    expect(lastAnswer().check!.flagged).toEqual([]);
  });

  // Review finding FIX-208d: the description of the network said nothing of priorities, batch
  // sizes or rate profiles, so such a network could only be explained as a plain one.
  it("the network's description names priorities, batch sizes and rate profiles, and a plain network's is unchanged", async () => {
    const ext = extendedExampleFiles();
    const doc = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(ext[`/examples/extended/${stem}.bnet`]) }) as BnetDocument;
    const plain = await run("get_parameters");
    expect(plain).not.toContain("not a plain network");
    expect(JSON.parse(await run("get_network_summary"))).not.toHaveProperty("model_features");

    open(doc("PriorityHelpDesk.mg1.2class"), "priority.bnet");
    const priority = await run("get_parameters");
    expect(priority).toContain("This is not a plain network of first-come-first-served stations with single arrivals at a constant rate.");
    expect(priority).toMatch(/S1 serves by priority, preemptive-resume \(a higher class interrupts a lower one, which later resumes where it stopped\); priority order, highest first: Class 1, then Class 2\. It is not a first-come-first-served station\./);
    const summary = JSON.parse(await run("get_network_summary")) as { nodes: Record<string, unknown>[]; model_features: string[] };
    expect(summary.nodes.find((n) => n.name === "S1")).toMatchObject({ service_discipline: "priorityPreemptiveResume", priority_order_highest_first: [0, 1] });
    expect(summary.model_features).toHaveLength(1);

    open(doc("BatchArrivals.mx-m-1.geometric"), "batch.bnet");
    expect(await run("get_parameters")).toContain("Src1 emits customers in batches: batch size geometric with mean 2.5 (mean batch size 2.5). Its interarrival law is of batches, so its customer rate is the batch rate times 2.5.");
    const batch = JSON.parse(await run("get_network_summary")) as { nodes: Record<string, unknown>[] };
    expect(batch.nodes.find((n) => n.name === "Src1")!.batch_size).toEqual({ kind: "geometric", mean: 2.5 });

    open(doc("RushHour.mt-m-2.daily"), "rush.bnet");
    const rush = await run("get_parameters");
    expect(rush).toMatch(/'s arrival rate changes over time: its own rate ×[\d.]+ from time 0 to [\d.]+; .*, then the pattern repeats \(long-run mean multiplier [\d.]+\)\. The network has no single steady state\./);
    const profile = (JSON.parse(await run("get_network_summary")) as { nodes: { rate_profile?: { periodic: boolean; segments: unknown[]; long_run_mean_multiplier: number } }[] }).nodes.find((n) => n.rate_profile)!.rate_profile!;
    expect(profile.periodic && profile.segments.length > 1 && Number.isFinite(profile.long_run_mean_multiplier)).toBe(true);
  });

  it("a closed network: live results say it is closed, and the open-network analyses say they do not apply rather than give numbers", async () => {
    open(closed(), "closed.bnet");
    const live = await run("get_live_results");
    expect(live).toContain("This is a closed network: a fixed population circulates.");
    expect(live).toContain("[live:network:delay] Mean cycle time = ");
    expect(live).toContain("[live:network:number] Population = ");
    const sensitivity = await run("get_sensitivity", { measure: "network_delay" });
    expect(sensitivity).toMatch(/^No sensitivity results: /);
    expect(sensitivity).toContain("Do not state any derivative or elasticity.");
    // FIX-110: it says outright that it only reads an estimate already made, and names the command that makes one.
    expect(sensitivity).toContain("No numerical estimate has been made for this network. get_sensitivity reports a numerical estimate only when the person has already made one for this measure and this network; it never starts one.");
    expect(sensitivity).toMatch(/To make one the person chooses Run ▸ Sensitivity…, then “Estimate Sensitivities” in the Sensitivity view \(about \d+ solver runs; the assistant cannot start it\)\. Tell the person this\./);
    expect(specItem("run:sensitivity")?.label).toBe("Sensitivity…");
    expect(EXPLAIN_TOOL_TEXT.get_sensitivity).toContain("only if the person has already made one (Run ▸ Sensitivity…, then “Estimate Sensitivities”)");
    // An estimate the person made is reported as theirs; one for another measure is named as such.
    const held: SensitivityResult = { route: "difference", tier: "approximation", method: { label: "qna", name: "Whitt QNA" }, measureKey: "networkSojourn", value: 2, target: null, targetChange: null, stations: [], bottlenecks: [], rows: [], leftOut: 0 };
    setSensitivityEstimate(tabId, { ...held, measureKey: "another" });
    expect(await run("get_sensitivity", { measure: "network_delay" })).toContain("The person's numerical estimate is for a different measure.");
    setSensitivityEstimate(tabId, { ...held, stopped: true });
    expect(await run("get_sensitivity", { measure: "network_delay" })).toContain("was stopped before it finished");
    setSensitivityEstimate(tabId, held);
    const made = await run("get_sensitivity", { measure: "network_delay" });
    expect(made).toContain("tier: approximation (central differences over runs of Whitt QNA).");
    expect(made).toContain("This is the numerical estimate the person made with Run ▸ Sensitivity… ▸ “Estimate Sensitivities”; this tool read it and ran nothing.");
    setSensitivityEstimate(tabId, null);
    expect(handlesIn(sensitivity)).toEqual([]);
    expect(await run("plan_capacity", { target: "network_delay", value: 1 })).toMatch(/^No capacity plan: .* Do not propose numbers of servers or rates\.$/);
    expect(await run("get_uncertainty", { measure: "network_delay" })).toMatch(/^No uncertainty analysis: /);
    mockAi.responder = explainModel;
    await ask(w.starters.bottleneck("S2"));
    expect(lastAnswer().text).toMatch(/^S2 is the bottleneck because it has the highest utilisation: 0\.949769 \[live:S2:rho\] \(tier: exact\)/);
    expect(lastAnswer().check!.flagged).toEqual([]);
    expect(lastAnswer().text).toContain("Qnet has no sensitivity results for this network");
  });

  it("an unstable network: the load is an offered load, the problem is reported, and no delay is given", async () => {
    open(withRate(example(JACKSON), "S2", 0.5), "unstable.bnet");
    const live = await run("get_live_results");
    expect(live).toContain("only the load at each station is known");
    expect(live).toContain("say 'offered load'");
    expect(live).toMatch(/\[live:S2:rho\] Offered load ρ at S2 = \d/);
    expect(handlesIn(live).some((h) => /:(number|sojourn|wait|delay)$/.test(h))).toBe(false);
    const problems = await run("get_problems");
    expect(problems).toMatch(/Error \((unstable|overloaded)\) at S2/);
    expect(handlesIn(problems)).toContain("problem:1:rho");
    expect(await run("get_sensitivity", { measure: "network_delay" })).toMatch(/^No sensitivity results: .*overloaded/);
    expect(await run("get_transient", {})).not.toMatch(/settling\] /);
  });
});

describe("the tools that act", () => {
  const plan = () => run("plan_capacity", { target: "utilisation_percent", value: 40 });
  const servers = () => editorFor(tabId).nodes.filter((n) => n.kind === "station").map((n) => n.numberOfServers);

  it("apply_capacity_plan asks first: declined, nothing changes; confirmed, the network changes in one undo step", async () => {
    expect(await run("apply_capacity_plan")).toBe("Nothing to apply: call plan_capacity first, and apply only a plan the person has seen.");
    const proposed = await plan();
    expect(proposed).toContain("Nothing has been changed. `apply_capacity_plan` would change the network to this plan; it asks the person first.");
    const before = servers();
    const asked: Question[] = [];
    setConfirmer(async (q) => (asked.push(q), false));
    expect(await run("apply_capacity_plan")).toBe("Not applied: the person declined. The network is unchanged. Do not ask again unless they bring it up.");
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe("Apply the capacity plan?");
    expect(asked[0].message).toMatch(/S\d: \d+ → \d+ servers/);
    expect(servers()).toEqual(before);

    setConfirmer(async () => true);
    const applied = await run("apply_capacity_plan");
    expect(applied).toMatch(/^Applied: S\d: \d+ → \d+ servers/);
    expect(applied).toContain("run Solve again before quoting any result");
    expect(servers()).not.toEqual(before);
    editorFor(tabId).undoManager.undo();
    expect(servers()).toEqual(before);
    // The plan is spent: a second call has nothing to apply.
    expect(await run("apply_capacity_plan")).toMatch(/^Nothing to apply/);
  });

  it("a plan made for another network is not applied, and editing waits while a dialog is open", async () => {
    await plan();
    let asked = 0;
    setConfirmer(async () => (asked++, true));
    const release = holdModal();
    await expect(run("apply_capacity_plan")).rejects.toThrow("Tool execution failed: A dialog or parameter panel is open in Qnet. Ask the user to close it, then try again.");
    release();
    editorFor(tabId).updateNodeDistribution(editorFor(tabId).nodes.find((n) => n.name === "S1")!.id, "exponential", "rate=3.0");
    expect(await run("apply_capacity_plan")).toBe("Not applied: the network has changed since the plan was made. Call plan_capacity again.");
    expect(asked).toBe(0);
  });

  it("run_sweep asks first and runs nothing when declined", async () => {
    const asked: Question[] = [];
    setConfirmer(async (q) => (asked.push(q), false));
    expect(await run("run_sweep", { parameter: "mu_S2", points: 4 })).toBe("Not run: the person declined the sweep. Do not ask again unless they bring it up.");
    expect(asked[0].title).toBe("Run a what-if sweep?");
    expect(asked[0].message).toContain("S2 service rate");
    expect(asked[0].message).toContain("The network itself is not changed.");
    await expect(run("run_sweep", { parameter: "mu_S9" })).rejects.toThrow(/^Invalid tool input: No parameter named "mu_S9"\. Parameters: /);
  });

  it("run_sweep, confirmed, returns each point with a handle and its tier", async () => {
    setConfirmer(async () => true);
    const text = await run("run_sweep", { parameter: "mu_S2", points: 3, metric: "Utilization", station: "S2" });
    expect(text).toMatch(/^What-if sweep of S2 service rate: Utilization at S2 at 3 values/);
    const facts = readFacts(text);
    expect(facts.filter((f) => /^sweep:\w+:\d$/.test(f.handle)).length).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/— tier: (exact|approximation)/);
  });

  it("solve follows run_command's rule: it refuses while the conversation's tab is not in front, and otherwise runs and reads the results", async () => {
    const mine = tabId;
    const other = addTab({ title: "other.bnet" });
    expect(await run("solve", {}, mine)).toMatch(/^Not run: this conversation belongs to the tab “OpenJackson\.d2\.feedback\.p30\.inf\.bnet”, but “other\.bnet” is in front/);
    expect(mockRuns.starts).toHaveLength(0);
    const { selectTab } = await import("../../../workspace/store");
    selectTab(mine);
    void other;
    const text = await run("solve", {}, mine);
    expect(text).toMatch(/^Solve chose: /);
    expect(mockRuns.starts).toHaveLength(1);
    expect(text).toMatch(/Run [0-9a-f]{8} — .* — tier: exact/);
    const release = holdModal();
    expect(await run("check_with_another_method", {}, mine)).toBe("Not run: a dialog or parameter panel is open in Qnet. Ask the user to close it, then try again.");
    release();
  });

  it("in a conversation: the assistant offers, the person agrees, and only then Solve runs", async () => {
    mockAi.responder = explainModel;
    await ask(w.starters.explain);
    expect(lastAnswer().text).toContain("Shall I run Solve?");
    expect(mockRuns.starts).toHaveLength(0);
    mockAi.responder = null;
    mockAi.script(toolTurn(call("solve")), textTurn("Solved."));
    await ask("Yes, please.");
    expect(toolRows().at(-1)).toMatchObject({ name: "solve", isError: false });
    expect(mockRuns.starts).toHaveLength(1);
  });
});
