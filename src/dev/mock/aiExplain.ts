// A scripted model for the assistant's explaining (src/panes/ai/explain/): no provider is called.
// It plays a careful model deterministically — for one of the pane's starters it calls the tools a
// model should, then writes its answer ONLY from the fact lines the tools returned, each number
// followed by its handle. The browser preview installs it (mockMain.tsx), and the tests use it as
// the well-behaved half of their transcripts; the badly-behaved half they script by hand.
import type { AiChatRequest, AiEvent, AiMessage } from "../../lib/types";
import { mockAi } from "./ai";

export interface ReadFact {
  handle: string;
  what: string;
  /** The value as the tool wrote it, with its unit words ("0.8", "2.33333 customers"). */
  value: string;
  tier: string;
}

/** The fact lines of a tool result: `[handle] what = value · tier`. */
export function readFacts(text: string): ReadFact[] {
  const out: ReadFact[] = [];
  for (const line of text.split("\n")) {
    const m = /^\[([^\]\s]+)\] (.+?) = (.+?)(?: \(= [^)]*\))?(?:, interval [^·]*)? · (.+)$/.exec(line);
    if (m) out.push({ handle: m[1], what: m[2], value: m[3], tier: m[4] });
  }
  return out;
}

let seq = 0;
const call = (name: string, input: Record<string, unknown> = {}): AiEvent => ({ kind: "toolCall", call: { id: `explain_${++seq}`, name, input } });
const tools = (...calls: AiEvent[]): AiEvent[] => [...calls, { kind: "done", stopReason: "toolUse" }];
const say = (text: string): AiEvent[] => [{ kind: "text", delta: text }, { kind: "done", stopReason: "end" }];
const cite = (f: ReadFact) => `${f.value} [${f.handle}]`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The turn a careful model would take for `request`, or null when the question is not one of the starters. */
export function explainModel(request: AiChatRequest): AiEvent[] | null {
  const at = request.messages.map((m) => m.role).lastIndexOf("user");
  const question = at >= 0 ? (request.messages[at] as Extract<AiMessage, { role: "user" }>).text : "";
  const after = request.messages.slice(at + 1);
  const results = after.flatMap((m) => (m.role === "tool" ? m.results : []));
  // Names arrive between ‹ and › (src/panes/ai/explain/guard.ts); this model writes them without the marks, as it is told to.
  const text = (name: string) => results.filter((r) => r.name === name && !r.isError).map((r) => r.content.replace(/[‹›]/g, "")).join("\n");
  const q = question.toLowerCase();
  const kind = /bottleneck/.test(q) ? "bottleneck" : /how sure/.test(q) ? "sure" : /methods paragraph/.test(q) ? "methods" : /try next/.test(q) ? "next" : /explain the method|which method/.test(q) ? "method" : /problem/.test(q) ? "problem" : /explain/.test(q) ? "explain" : null;
  if (!kind) return null;

  if (!results.length) {
    switch (kind) {
      case "bottleneck":
        return tools(call("get_live_results"), call("get_sensitivity", { measure: "network_delay" }));
      case "sure":
      case "explain":
        return tools(call("get_results"), call("get_agreement"));
      case "methods":
        return tools(call("get_parameters"), call("get_results"), call("get_agreement"));
      case "next":
        return tools(call("get_results"), call("get_problems"), call("list_methods"));
      case "method":
        return tools(call("list_methods"));
      case "problem":
        return tools(call("get_problems"));
    }
  }

  const all = results.map((r) => r.content).join("\n");
  const none = /^No results/m.test(text("get_results"));
  const offer = "Nothing has been solved for this network yet, so I have no numbers to give you. Shall I run Solve?";

  if (kind === "method") {
    const help = text("get_help");
    if (!help) {
      const topic = /Help topic: (\w+)/.exec(text("list_methods"))?.[1];
      return topic ? tools(call("get_help", { topic })) : say("I don't know: Qnet could not tell me which methods apply to this network.");
    }
    const handle = /^\[(help:[^\]]+)\]/m.exec(help)?.[1];
    const first = help.split("\n").slice(1).find((l) => l.trim().length > 60 && !/\d/.test(l)) ?? "";
    return say(`From Qnet's Help [${handle}]: ${first.trim()}\n\nOpen the article from the chip for the assumptions and the references.`);
  }

  if (kind === "problem") {
    const lines = text("get_problems").split("\n").filter((l) => /^\d+\. /.test(l)).slice(0, 3);
    if (!lines.length) return say("Qnet's checks find no problems with this network.");
    return say(`Qnet's checks say:\n\n${lines.map((l) => `- ${l.replace(/^\d+\. /, "").replace(/\d[\d.]*/g, "…")}`).join("\n")}\n\nOpen the problem on the canvas for its fixes.`);
  }

  if (kind === "bottleneck") {
    const live = text("get_live_results");
    const names = (/^Bottleneck \(highest ρ\): (.+?)(?: \(a tie\))?\.$/m.exec(live)?.[1] ?? "").split(" and ").filter(Boolean);
    const rhos = names.map((n) => readFacts(live).find((f) => f.handle === `live:${n.replace(/\s+/g, "_")}:rho`));
    const name = names[0];
    const rho = rhos[0];
    if (names.length > 1 && rhos.every(Boolean)) return say(`There is no single bottleneck: ${names.join(" and ")} tie for the highest utilisation — ${rhos.map((r) => cite(r!)).join(" and ")} (tier: ${rhos[0]!.tier}).\n\nNext step: change the service rate at one of them and solve again to see which one then limits the network.`);
    if (!name || !rho) return say("I don't know which station is the bottleneck: Qnet's live results have no utilisations for this network. Running Solve would give them — shall I?");
    const top = readFacts(text("get_sensitivity")).find((f) => /^Elasticity/.test(f.what));
    let out = `${name} is the bottleneck because it has the highest utilisation: ${cite(rho)} (tier: ${rho.tier}). A station close to 1 leaves little spare capacity, so queues build there first.`;
    if (top) out += `\n\nThe delay through the network reacts most to this parameter — ${lower(top.what)}: ${cite(top)} (tier: ${top.tier}).`;
    else out += "\n\nQnet has no sensitivity results for this network, so I can't say which parameter matters most.";
    return say(`${out}\n\nNext step: try one more server at ${name}, or a faster service rate there, and solve again.`);
  }

  if (none && kind !== "next") return say(offer);
  const facts = readFacts(all);
  const verdict = /^Verdict[^:]*: (\w+)/m.exec(text("get_agreement"))?.[1] ?? null;
  const single = /Only one method has run/.test(text("get_agreement"));
  const runs = [...text("get_results").matchAll(/^Run \w+ — (.+?) — tier: (.+?)(?: —.*)?$/gm)].map((m) => `${m[1]} (${m[2]})`);

  if (kind === "next") {
    if (none) return say(`${offer} That is the first experiment: it gives the utilisation of every station.`);
    const problems = /(\d+) error\(s\), (\d+) warning\(s\)/.exec(text("get_problems"));
    if (single || !verdict) return say("Only one method has run, so nothing has been cross-checked. Next step: Check with Another Method, to see whether a second method agrees. Shall I run it?");
    return say(`The methods that ran ${verdict === "agree" || verdict === "exact" ? "agree" : `do not fully agree (verdict: ${verdict})`}${problems ? "" : ""}. Next step: a what-if sweep of the bottleneck's service rate, to see how fast the delay grows as the station fills.`);
  }

  const shown = facts.filter((f) => /^run:/.test(f.handle)).slice(0, 6);
  const bullets = shown.map((f) => `- ${f.what}: ${cite(f)} — ${f.tier}`).join("\n");
  const sureness = single || !verdict ? "Only one method has run, so nothing has been cross-checked." : `Methods compared: verdict “${verdict}”.`;

  if (kind === "methods") {
    const version = /^\[app:version\] Software: (.+)$/m.exec(text("get_parameters"))?.[1];
    const inputs = readFacts(text("get_parameters")).slice(0, 8).map((f) => `${f.what} ${cite(f)}`).join(", ");
    return say(
      `**Methods.** The network was analysed with ${version ? `${version.replace(/\d[\d.]*/, (v) => `${v} [app:version]`)}` : "Qnet"}. Its parameters were: ${inputs}. ` +
        `It was solved with ${runs.join(" and ") || "the methods listed"}. ${sureness}\n\n` +
        `**Not checked.** ${single || !verdict ? "No second method was run to confirm the result." : "Agreement between methods is evidence, not proof."} The parameters were taken as exact; their uncertainty was not studied.`,
    );
  }
  if (kind === "sure") return say(`${sureness}\n\n${bullets}\n\n${single || !verdict ? "Next step: Check with Another Method — shall I run it?" : "Next step: if the inputs are estimates, ask how uncertain the answer is given their uncertainty."}`);
  return say(`Here is what Qnet computed for the network as it is now (${runs[0] ?? "one method"}):\n\n${bullets}\n\n${sureness}`);
}

/** The preview's: answers the starters from the tools, everything else with the default text. */
export function installExplainModel() {
  mockAi.responder = explainModel;
}
