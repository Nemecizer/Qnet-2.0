// Explaining, as the pane shows it (ledger WF-404…WF-406): the starters that fit the tab, the
// citation chips and what a click on one selects, the visible mark on a number that could not be
// verified, and the "Explain" affordance other views carry.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { example } from "../../../canvas/layers/testkit";
import { DialogHost } from "../../../components/DialogHost";
import { defaultHandlers } from "../../../dev/mockBackend";
import { mockAi } from "../../../dev/mock/ai";
import { explainModel, readFacts } from "../../../dev/mock/aiExplain";
import { mockRuns } from "../../../dev/mock/runs";
import { mockQuietRecord } from "../../../dev/mock/sweeps2";
import { editorFor } from "../../../editor";
import { api } from "../../../lib/api";
import { loadKv, resetKv } from "../../../lib/kv";
import { resetStructures } from "../../../results/current";
import { resetSelectedRuns, selectedRunFor } from "../../../results/selectedRun";
import { reloadResults, resetRuns } from "../../../runs/state";
import { mockTauri } from "../../../test/tauri";
import { helpState, resetHelpWindow } from "../../../windows/help/state";
import { addTab, tabById } from "../../../workspace/store";
import { AIPane, aiLaunch } from "../AIPane";
import { draft, resetAi, whenIdle } from "../model";
import { call, textTurn, tick, toolTurn } from "../testing";
import { aiWords as w } from "../words";
import { ExplainButton, startersFor } from "./open";

const JACKSON = "OpenJackson.d2.feedback.p30.inf.bnet";
let tabId: string;

async function record(method: string) {
  const tab = tabById(tabId)!;
  const r = mockQuietRecord({ tabId, title: tab.title, method }, tab.document) as unknown as { id: string; provenance: { networkFingerprint: string } };
  r.provenance.networkFingerprint = await api.resultsFingerprint(tab.document);
  mockRuns.records.push(r as never);
  await reloadResults(tabId);
  return r.id;
}

async function start(withRuns: string[] = []) {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "ollama", "ai.model.ollama": "llama3.2" } }));
  resetKv();
  resetRuns();
  resetStructures();
  resetSelectedRuns();
  await loadKv();
  tabId = addTab({ title: JACKSON, document: { ...example(JACKSON), nodes: example(JACKSON).nodes.map((n) => (n.name === "S2" ? { ...n, distributionParameters: "rate=1.2" } : n)) } });
  const ids: string[] = [];
  for (const m of withRuns) ids.push(await record(m));
  render(
    <>
      <AIPane />
      <DialogHost />
    </>,
  );
  await act(() => tick(0));
  return ids;
}
const composer = () => screen.getByRole("textbox", { name: "Message to the AI assistant" }) as HTMLTextAreaElement;
const say = async (text: string) => {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
  await act(async () => {
    await whenIdle();
    await tick(0);
  });
};
const starters = () => within(screen.getByRole("group", { name: "No messages yet" })).getAllByRole("button").map((b) => b.textContent);

beforeEach(() => {
  aiLaunch.at = Date.now();
});
afterEach(() => {
  resetAi();
  resetHelpWindow();
});

describe("starters", () => {
  it("with no results: what to try and which method, never 'explain this result'", async () => {
    await start();
    expect(starters()).toEqual(["What should I try next?", "Which method should I use, and why?", "Summarise this network"]);
  });

  it("with results: explain, the bottleneck by name, what next, how sure, a methods paragraph, the method by name", async () => {
    await start(["product_form"]);
    await waitFor(() => expect(starters()).toEqual(["Explain this result", "Why is S2 the bottleneck?", "What should I try next?", "How sure is this answer?", "Draft a methods paragraph", "Explain the method Exact Open Product Form"]));
    fireEvent.click(screen.getByRole("button", { name: "Example prompt: Why is S2 the bottleneck?" }));
    expect(composer().value).toBe("Why is S2 the bottleneck?");
  });

  it("a tie has no bottleneck starter, and an empty canvas keeps 0.90.34's three", () => {
    expect(startersFor({ hasNetwork: false, runs: [] })).toEqual(w.starterPrompts);
    const doc = example(JACKSON);
    const tied = mockQuietRecord({ tabId: "T", title: "t", method: "product_form" }, doc) as never;
    expect(startersFor({ hasNetwork: true, runs: [tied] })).not.toContain("Why is S2 the bottleneck?");
  });
});

describe("citations in the transcript", () => {
  it("a handle is a chip naming its source; clicking it selects that run and station", async () => {
    const [runId] = await start(["product_form"]);
    mockAi.responder = explainModel;
    await say(w.starters.explain);
    const chips = screen.getAllByRole("button", { name: "Source: Exact Open Product Form (run " + runId.slice(0, 8).toLowerCase() + ")" });
    expect(chips.length).toBeGreaterThan(3);
    expect(chips[0]).toHaveTextContent("Exact Open Product Form · exact");
    expect(chips[0].getAttribute("title")).toMatch(/^Utilization at S1 = 0\.7\nTier: exact\nFrom: Exact Open Product Form \(run [0-9a-f]{8}\)\nClick to show it$/);
    // The raw handle is not shown as text, and nothing is marked.
    expect(screen.getByRole("log").textContent).not.toContain("[run:");
    expect(screen.queryByText(w.flagWord)).toBeNull();
    expect(selectedRunFor(tabId)).toBeNull();
    fireEvent.click(chips[0]);
    expect(selectedRunFor(tabId)).toBe(runId);
    const s1 = editorFor(tabId).nodes.find((n) => n.name === "S1")!.id;
    expect(editorFor(tabId).view.selectedNodeID).toBe(s1);
  });

  it("an unverified number is marked where it stands, in words, with the reason, and counted under the reply", async () => {
    await start(["product_form"]);
    mockAi.responder = (request) => {
      const results = request.messages.flatMap((m) => (m.role === "tool" ? m.results : []));
      if (!results.length) return toolTurn(call("get_results"));
      const rho = readFacts(results[0].content).find((f) => /:S1:utilisation$/.test(f.handle))!;
      return textTurn(`S1 is busy **${rho.value}** [${rho.handle}]. The wait there is **12.7** time units, and S2 is at 0.99 [${rho.handle}] or so [live:S7:rho].`);
    };
    await say("Explain");
    const marks = screen.getAllByRole("note").filter((n) => n.classList.contains("ai-unverified"));
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([
      "12.7: Unverified number: it does not match the result it cites (which is 0.7 (ratio)).",
      "0.99: Unverified number: it does not match the result it cites (which is 0.7 (ratio)).",
    ]);
    expect(marks[0]).toHaveTextContent("12.7unverified number");
    expect(marks[0].closest("strong")).not.toBeNull();
    expect(screen.getByText("2 unverified numbers in this answer — marked. Check them against the results before relying on them.")).toBeInTheDocument();
    // A handle the assistant was never given is a chip that says so, and cannot be clicked.
    const unknown = screen.getByRole("note", { name: w.chipUnknown });
    expect(unknown).toHaveTextContent("unknown source");
    expect(unknown.tagName).toBe("SPAN");
  });

  it("a Help citation opens the article", async () => {
    await start();
    mockAi.responder = explainModel;
    await say(w.starters.method("Whitt QNA"));
    const chip = screen.getAllByRole("button").find((b) => b.getAttribute("data-handle")?.startsWith("help:"))!;
    expect(chip.getAttribute("title")).toMatch(/^From Qnet Help: .+\nClick to open it$/);
    fireEvent.click(chip);
    expect(helpState().open).toBe(true);
  });
});

describe("the Explain affordance", () => {
  it("puts the right question in the message field without sending it", async () => {
    await start();
    render(
      <>
        <ExplainButton about="agreement" />
        <ExplainButton about="problem" detail="S2 is overloaded." />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explain how sure this answer is, with the AI Assistant" }));
    expect(draft()).toBe("How sure is this answer?");
    fireEvent.click(screen.getByRole("button", { name: "Explain this problem with the AI Assistant" }));
    expect(draft()).toBe("Explain this problem and how to fix it: “S2 is overloaded.”");
    expect(mockAi.requests).toHaveLength(0);
  });
});
