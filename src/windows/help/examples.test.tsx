// Help's runnable examples (new in 2.1, ledger UX-401…): the example block of an article and its
// two buttons; opening the example and starting the method in the main window; and the integrity
// of every reference — each example an article names is a bundled example, each method named is a
// Run-menu command of that example's buffer mode, and 0.90.34's own recorded run of that method on
// that example (golden/runs/<example>/<run label>/) finished, in seconds. A name nothing knows
// fails here, not silently in front of a student.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { registerCommands } from "../../lib/commands";
import { specItem } from "../../lib/menuSpec";
import { getToasts } from "../../lib/toasts";
import { followRun, resetRuns, runActive } from "../../runs/state";
import { runItem } from "../../runs/ui/commands";
import { lintHelp } from "../../../scripts/help-lint.mjs";
import { mockTauri } from "../../test/tauri";
import { activeTab, getWorkspace } from "../../workspace/store";
import { Article } from "./Article";
import { exampleMethodName, openHelpExample, SETTLE_MS } from "./examples";
import { dumpBlocks, EXAMPLE_SCHEME, exampleTarget, matchingBlocks, parseMarkdown, plainText, type Block } from "./markdown";
import { topicBlocks, TOPICS, topicSource } from "./topics";

// The examples folder and its subfolders one level down ("closed/…", "extended/…").
const bundled = import.meta.glob(["../../../examples/*.bnet", "../../../examples/*/*.bnet"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const exampleText = (name: string) => bundled[`../../../examples/${name}.bnet`];
const exits = import.meta.glob("../../../golden/runs/*/*/exit.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const summaries = import.meta.glob("../../../golden/runs/*/*/summary.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const records = import.meta.glob("../../../golden/runs/*/*/record.json", { query: "?raw", import: "default" });
const golden = (example: string, label: string, file: string) => `../../../golden/runs/${example}/${label}/${file}`;

type Example = Extract<Block, { kind: "example" }>;
const examplesOf = (id: string) => topicBlocks(id).filter((b): b is Example => b.kind === "example");

/** The method each method article is about, as its Run-menu command. */
const ARTICLE_METHOD: Record<string, string> = {
  spectralInfinite: "run:spectral-infinite",
  qna: "run:qna",
  rqna: "run:rqna",
  sbd: "run:sbd",
  simulationInfinite: "run:monte-carlo-infinite",
  regenerativeSimulation: "run:regenerative-infinite",
  exactSimulation: "run:mlmc",
  linearProgramInfinite: "run:lp",
  adaptiveTruncatedCTMC: "run:truncated-ctmc",
  adaptiveLowRankBAR: "run:low-rank-bar",
  barMomentBounds: "run:bar-bounds",
  multiClassSRBM: "run:multiclass",
  spectralFinite: "run:spectral-finite",
  finiteElement: "run:finite-element",
  finiteLP: "run:finite-lp",
  ctmc: "run:generic-ctmc",
  finiteDecomposition: "run:decomposition",
  simulationFinite: "run:monte-carlo-finite",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an article's example block", () => {
  const source = [
    "# TITLE",
    "",
    "## TRY IT",
    "",
    "[Example network: three stations in a line (3dtandem.inf)](qnet-example:3dtandem.inf?run=run:qna)",
    "",
    "Look at the queue.",
    "",
    "[Example network: a small one (2dtandem)](qnet-example:2dtandem)",
    "",
    "A sentence with [an example link](qnet-example:2dtandem) inside it.",
  ].join("\n");

  it("is a paragraph that is one qnet-example: link; its name, its method and its text are kept", () => {
    const blocks = parseMarkdown(source);
    expect(blocks.filter((b) => b.kind === "example")).toEqual([
      { kind: "example", level: 0, example: "3dtandem.inf", run: "run:qna", text: "Example network: three stations in a line (3dtandem.inf)" },
      { kind: "example", level: 0, example: "2dtandem", run: null, text: "Example network: a small one (2dtandem)" },
    ]);
    // A link inside a sentence is not a block (the lint refuses it; the page shows its words).
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: "paragraph", text: "A sentence with an example link inside it." });
    expect(exampleTarget("qnet-example:3dtandem.inf?run=run:qna")).toEqual({ example: "3dtandem.inf", run: "run:qna" });
    // An example in a subfolder of examples/: one folder name, then the file's.
    expect(exampleTarget("qnet-example:closed/ClosedCentralServer.d3.N8")).toEqual({ example: "closed/ClosedCentralServer.d3.N8", run: null });
    expect(exampleTarget("qnet-example:extended/RushHour.mt-m-2.daily?run=run:qna")).toEqual({ example: "extended/RushHour.mt-m-2.daily", run: "run:qna" });
    for (const bad of ["qnet-example:", "qnet-example:../secret", "qnet-example:a b", "qnet-example:x?run=file:open", "qnet-example:x?run=", "help:qna", "qnet-example:a/../b", "qnet-example:a/b/c", "qnet-example:/b", "qnet-example:a/", "qnet-example:.hidden/b", "qnet-example:a.b/c"]) expect(exampleTarget(bad), bad).toBeNull();
  });

  it("reads as its words in search, in the plain-text destinations and in the block dump", () => {
    const blocks = parseMarkdown(source);
    expect(matchingBlocks(blocks, "three stations")).toEqual([2]);
    expect(plainText(blocks)).toContain("\nExample network: three stations in a line (3dtandem.inf)\n");
    expect(plainText(blocks)).not.toContain(EXAMPLE_SCHEME);
    expect(dumpBlocks(blocks)).toContain("EXAMPLE   | 3dtandem.inf run:qna | Example network: three stations in a line (3dtandem.inf)\n");
    expect(dumpBlocks(blocks)).toContain("EXAMPLE   | 2dtandem | Example network: a small one (2dtandem)\n");
  });

  it("is drawn as a named group with Open This Example, and Open and Run where a method is named", () => {
    const onExample = vi.fn();
    render(<Article blocks={parseMarkdown(source)} query="" currentBlock={null} onTopic={() => {}} onExternal={() => {}} onExample={onExample} methodName={exampleMethodName} />);
    const first = screen.getByRole("group", { name: "Example network 3dtandem.inf" });
    expect(first).toHaveTextContent("Example network: three stations in a line (3dtandem.inf)");
    const open = within(first).getByRole("button", { name: "Open This Example" });
    const run = within(first).getByRole("button", { name: "Open and Run" });
    expect(open).toHaveAttribute("title", "Open the bundled example “3dtandem.inf” in the main window, as File ▸ Open Example… does");
    expect(run).toHaveAttribute("title", "Open “3dtandem.inf” in the main window and start Whitt QNA on it");
    fireEvent.click(open);
    fireEvent.click(run);
    expect(onExample.mock.calls).toEqual([["3dtandem.inf", null], ["3dtandem.inf", "run:qna"]]);

    const second = screen.getByRole("group", { name: "Example network 2dtandem" });
    expect(within(second).getByRole("button", { name: "Open This Example" })).toBeInTheDocument();
    expect(within(second).queryByRole("button", { name: "Open and Run" })).toBeNull();
    // Both are reachable by keyboard: plain buttons, in reading order.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open This Example", "Open and Run", "Open This Example"]);
    // The link inside a sentence is words, not a link or a button.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("A sentence with an example link inside it.")).toBeInTheDocument();
  });

  it("marks the search text and the block the match cursor is on", () => {
    const blocks = parseMarkdown(source);
    render(<Article blocks={blocks} query="stations" currentBlock={2} onTopic={() => {}} onExternal={() => {}} />);
    const group = screen.getByRole("group", { name: "Example network 3dtandem.inf" });
    expect(group).toHaveAttribute("data-current");
    expect(group.querySelector("mark.help-mark.current")).toHaveTextContent("stations");
  });

  it("names the method as the Run menu does", () => {
    expect(exampleMethodName("run:qna")).toBe("Whitt QNA");
    expect(exampleMethodName("run:monte-carlo-finite")).toBe("Monte Carlo");
    expect(exampleMethodName("run:nothing")).toBe("run:nothing");
  });
});

describe("opening an example from Help", () => {
  const grace = { ...SETTLE_MS };
  afterEach(() => Object.assign(SETTLE_MS, grace));

  function setup() {
    mockTauri(defaultHandlers());
    render(<DialogHost />);
  }

  it("opens the bundled example in the main window, by the path File ▸ Open Example… ends in", async () => {
    setup();
    await act(async () => {
      expect(await openHelpExample("Tandem2.MM1.K5.fin", null)).toBe(true);
    });
    expect(activeTab().title).toBe("Tandem2.MM1.K5.fin.bnet");
    expect(activeTab().path).toBe("/examples/Tandem2.MM1.K5.fin.bnet");
    expect(activeTab().document.nodes.length).toBeGreaterThan(0);
    // A second example goes to a new tab: the first is no longer blank.
    await act(async () => {
      await openHelpExample("3dtandem.inf", null);
    });
    expect(getWorkspace().tabs.map((t) => t.title)).toEqual(["Tandem2.MM1.K5.fin.bnet", "3dtandem.inf.bnet"]);
  });

  it("opens an example from a subfolder of the examples folder (review finding FIX-208e)", async () => {
    setup();
    await act(async () => {
      expect(await openHelpExample("closed/ClosedCentralServer.d3.N8", null)).toBe(true);
    });
    expect(activeTab().title).toBe("ClosedCentralServer.d3.N8.bnet");
    expect(activeTab().path).toBe("/examples/closed/ClosedCentralServer.d3.N8.bnet");
    expect(activeTab().document.closedPopulation).toBe(8);
    await act(async () => {
      expect(await openHelpExample("extended/PriorityHelpDesk.mg1.2class", null)).toBe(true);
    });
    expect(activeTab().path).toBe("/examples/extended/PriorityHelpDesk.mg1.2class.bnet");
    expect(activeTab().document.nodes.some((n) => n.serviceDiscipline === "priorityPreemptiveResume")).toBe(true);
  });

  it("Open and Run starts the method's Run-menu command on the opened example, after the open has settled", async () => {
    setup();
    Object.assign(SETTLE_MS, { grace: 20, cap: 200, step: 5 });
    const order: string[] = [];
    const stop = registerCommands([
      { id: "network:primitives", title: "Show Network Primitives", group: "Network", run: () => void order.push("primitives") },
      { id: "run:qna", title: "Run Whitt QNA", group: "Run", run: () => void order.push(`qna on ${activeTab().title}`) },
    ]);
    try {
      await act(async () => {
        expect(await openHelpExample("3dtandem.inf", "run:qna")).toBe(true);
      });
      expect(order).toEqual(["primitives", "qna on 3dtandem.inf.bnet"]);
    } finally {
      stop();
    }
  });

  it("Open and Run with a run in progress says so at once and opens nothing", async () => {
    setup();
    const ran = vi.fn();
    const stop = registerCommands([{ id: "run:qna", title: "Run Whitt QNA", group: "Run", run: ran }]);
    const tabs = getWorkspace().tabs.length;
    // A run that has started and not finished holds the one slot.
    await act(async () => void (await followRun(activeTab().id, "qna", async () => ({ started: true }))));
    expect(runActive()).toBe(true);
    try {
      const began = Date.now();
      await act(async () => {
        expect(await openHelpExample("3dtandem.inf", "run:qna")).toBe(false);
      });
      expect(Date.now() - began).toBeLessThan(SETTLE_MS.grace);
      expect(getToasts().some((t) => t.title === "Example not run" && t.body === "A run is in progress. Wait for it to finish, or stop it, then try again.")).toBe(true);
      expect(getWorkspace().tabs).toHaveLength(tabs);
      expect(ran).not.toHaveBeenCalled();
      // Only opening is not a run: it still opens.
      await act(async () => {
        expect(await openHelpExample("3dtandem.inf", null)).toBe(true);
      });
    } finally {
      stop();
      resetRuns();
    }
  });

  it("Open and Run waits for the opened tab's own primitives report, not another tab's", async () => {
    setup();
    Object.assign(SETTLE_MS, { grace: 150, cap: 1000, step: 5 });
    const other = activeTab().id;
    let opened = 0;
    let ranAt = 0;
    const finished = { kind: "finished", succeeded: true, userStopped: false, statusBar: "", summary: "", recordId: null } as never;
    const stop = registerCommands([
      {
        id: "network:primitives",
        title: "Show Network Primitives",
        group: "Network",
        // The open's own report is still to come; meanwhile another tab's report ends.
        run: () => {
          opened = Date.now();
          void followRun(other, "primitives", async (on) => {
            on(finished);
            return { started: true };
          });
        },
      },
      { id: "run:qna", title: "Run Whitt QNA", group: "Run", run: () => void (ranAt = Date.now()) },
    ]);
    try {
      await act(async () => {
        await openHelpExample("2dtandem", null);
        expect(await openHelpExample("3dtandem.inf", "run:qna")).toBe(true);
      });
      expect(activeTab().id).not.toBe(other);
      expect(ranAt - opened).toBeGreaterThanOrEqual(140);
    } finally {
      stop();
      resetRuns();
    }
  });

  it("an example that is not there says so in an alert, and runs nothing", async () => {
    setup();
    const ran = vi.fn();
    const stop = registerCommands([{ id: "run:qna", title: "Run Whitt QNA", group: "Run", run: ran }]);
    try {
      let done: Promise<boolean>;
      act(() => {
        done = openHelpExample("NoSuchExample", "run:qna");
      });
      const alert = await screen.findByRole("alertdialog", { name: "Load Failed" });
      expect(alert).toHaveTextContent("Qnet couldn't read “NoSuchExample.bnet”.");
      fireEvent.click(within(alert).getByRole("button", { name: "OK" }));
      await act(async () => {
        expect(await done!).toBe(false);
      });
      expect(ran).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("a method that is not a command says so in a toast after opening the example", async () => {
    setup();
    Object.assign(SETTLE_MS, { grace: 5, cap: 50, step: 5 });
    await act(async () => {
      expect(await openHelpExample("2dtandem", "run:nothing")).toBe(false);
    });
    expect(activeTab().title).toBe("2dtandem.bnet");
    await waitFor(() => expect(getToasts().some((t) => t.title === "Example not opened" && /no Run command “run:nothing”/.test(t.body ?? ""))).toBe(true));
  });

  it("says so when the examples folder cannot be found", async () => {
    mockTauri({ ...defaultHandlers(), examples_locate: () => ({ path: null, searched: [], trail: "/nowhere", home: "/" }) });
    await act(async () => {
      expect(await openHelpExample("2dtandem", null)).toBe(false);
    });
    expect(getToasts().some((t) => t.title === "Example not opened")).toBe(true);
    expect(activeTab().log.map((e) => e.text)).toContain("No examples directory found — looked in: /nowhere.");
  });
});

describe("every example Help refers to", () => {
  const all = TOPICS.flatMap((t) => examplesOf(t.id).map((b) => ({ topic: t.id, ...b })));

  it("is written as a block of its own: no qnet-example: address is left inside a sentence or malformed", () => {
    for (const t of TOPICS) {
      const written = (topicSource(t.id) ?? "").split(EXAMPLE_SCHEME).length - 1;
      expect(examplesOf(t.id), `${t.id}: ${written} written`).toHaveLength(written);
    }
    expect(all.length).toBeGreaterThanOrEqual(Object.keys(ARTICLE_METHOD).length);
  });

  it.each(all.map((e) => [e.topic, e.example, e.run ?? "open only"] as const))("%s: %s (%s) is a bundled example", (_topic, example) => {
    expect(exampleText(example), `examples/${example}.bnet`).toBeDefined();
    const doc = JSON.parse(exampleText(example)) as { nodes: unknown[] };
    expect(doc.nodes.length).toBeGreaterThan(0);
  });

  it.each(all.filter((e) => e.run !== null).map((e) => [e.topic, e.example, e.run!] as const))(
    "%s: on %s, %s is a Run-menu method of that buffer mode whose recorded run finished in seconds",
    (_topic, example, run) => {
      const item = runItem(run);
      expect(item, `${run} is a Run-menu method`).toBeDefined();
      expect(specItem(run), `${run} is in the menu`).toBeDefined();
      const infinite = (JSON.parse(exampleText(example)) as { infiniteBuffers?: boolean }).infiniteBuffers === true;
      expect(item!.mode === "either" || item!.mode === (infinite ? "infinite" : "finite"), `${run} runs on ${infinite ? "infinite" : "finite"} buffers`).toBe(true);
      // 0.90.34's own run of this method on this example: it exited 0, filed a record, and was quick.
      const label = item!.label(infinite);
      expect(exits[golden(example, label, "exit.txt")]?.trim(), `golden/runs/${example}/${label}/exit.txt`).toBe("0");
      expect(records[golden(example, label, "record.json")], `golden/runs/${example}/${label}/record.json`).toBeDefined();
      const seconds = / finished in (\d+(?:\.\d+)?) s\b/.exec(summaries[golden(example, label, "summary.txt")] ?? "");
      expect(seconds, `golden/runs/${example}/${label}/summary.txt`).not.toBeNull();
      expect(Number(seconds![1])).toBeLessThan(10);
    },
  );

  it("a name nothing knows would fail these checks", () => {
    expect(exampleText("NoSuchExample")).toBeUndefined();
    expect(runItem("run:nothing")).toBeUndefined();
    expect(exits[golden("2dtandem", "qna", "exit.txt")]).toBeUndefined(); // a finite example has no QNA run
  });

  it("each method article offers its own method on an example, followed by what to look at", () => {
    const methods = TOPICS.filter((t) => t.kind === "method" || t.kind === "guide").map((t) => t.id);
    expect(methods.sort()).toEqual(Object.keys(ARTICLE_METHOD).sort());
    for (const id of methods) {
      const blocks = topicBlocks(id);
      const mine = examplesOf(id);
      expect(mine.map((b) => b.run), id).toEqual([ARTICLE_METHOD[id]]);
      const at = blocks.indexOf(mine[0]);
      expect(blocks[at - 1], id).toMatchObject({ kind: "headline", text: "TRY IT" });
      expect(blocks[at + 1]?.kind, `${id}: a sentence after the example`).toBe("paragraph");
      expect(blocks[at + 1].text.length, id).toBeGreaterThan(40);
      // The block's words name the example, so the Status and Shell destinations can be followed by hand.
      expect(mine[0].text, id).toContain(`(${mine[0].example})`);
    }
  });

  it("the articles on closed networks, priorities, batches and rate profiles each open their own example from its subfolder", () => {
    const want: Record<string, string> = { closedNetworks: "closed/ClosedCentralServer.d3.N8", priorityQueues: "extended/PriorityHelpDesk.mg1.2class", batchArrivals: "extended/BatchArrivals.mx-m-1.geometric", timeVaryingRates: "extended/RushHour.mt-m-2.daily" };
    for (const [id, example] of Object.entries(want)) {
      expect(examplesOf(id).map((b) => [b.example, b.run]), id).toEqual([[example, null]]);
      expect(exampleText(example), `examples/${example}.bnet`).toBeDefined();
      // The block's words name the file, so it can be found by hand in File ▸ Open Example….
      expect(examplesOf(id)[0].text, id).toContain(`(${example.split("/")[1]})`);
    }
    // Every bundled example in a subfolder is offered by some article.
    const inFolders = Object.keys(bundled).map((p) => p.replace("../../../examples/", "").replace(/\.bnet$/, "")).filter((n) => n.includes("/"));
    expect(inFolders.sort()).toEqual(Object.values(want).sort());
  });

  it("the 2.1 articles each offer an example, and the lint refuses a malformed or inline address", () => {
    for (const id of ["startHere", "solve", "agreementView", "resultsOnCanvas", "charts", "whatIfSweeps"]) expect(examplesOf(id).length, id).toBe(1);
    const manifest = [{ id: "a", title: "A", section: "S", file: "a.md", keywords: [], kind: "topic" }];
    const lint = (line: string) => lintHelp({ manifest, files: { "a.md": `# A\n\n${line}\n` } });
    expect(lint("[Example](qnet-example:2dtandem?run=run:spectral-finite)")).toEqual([]);
    expect(lint("[Example](qnet-example:closed/ClosedCentralServer.d3.N8)")).toEqual([]);
    expect(lint("[Example](qnet-example:../golden/x)")[0]).toMatch(/is not qnet-example:<name>/);
    expect(lint("[Example](qnet-example:a/b/c)")[0]).toMatch(/is not qnet-example:<name>/);
    expect(lint("[Example](qnet-example:2dtandem?method=sm)")[0]).toMatch(/^links: a\.md:3: "qnet-example:2dtandem\?method=sm" is not qnet-example:<name>/);
    expect(lint("See [the example](qnet-example:2dtandem) here.")).toEqual(["links: a.md:3: a qnet-example: link must be a paragraph of its own"]);
  });
});
