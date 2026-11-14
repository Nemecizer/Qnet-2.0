// Qnet Help against the real topics (docs/help/manifest.json and its Markdown files) and the
// preview backend: the window's sidebar, article, search and links; the three destinations; every
// Help-menu command; the help buttons other windows carry; and the generated Keyboard Shortcuts
// reference. Ledger sections 14.1 and 14.4, 1.10, KEY-035…038, SET-180, SET-200, LOG-029.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers, type MockOptions } from "../../dev/mockBackend";
import { mockHelp } from "../../dev/mock/help";
import { mockRuns } from "../../dev/mock/runs";
import { editorFeedback } from "../../editor";
import { getCommand, getCommands, runCommand } from "../../lib/commands";
import { getStateValue, loadKv, setSettings } from "../../lib/kv";
import { displayAccel, resolveMenu, shortcutFor, type MenuNode } from "../../lib/menu";
import { AI_PROVIDER_TOPICS, MENU_SPEC, METHOD_REFERENCE, type SpecEntry } from "../../lib/menuSpec";
import { onRunOutput, startRun, stopRun, getRunState } from "../../runs/state";
import { comparisonBlocking, finiteElement, linearProgram, monteCarloFinite, monteCarloInfinite, multiClass, regenerative, spectralFinite, spectralInfinite } from "../../runs/ui/specs";
import { mockTauri } from "../../test/tauri";
import { handlersFor } from "../../workspace/focus";
import { paneWords } from "../../workspace/panes/words";
import { activeTab, addTab, getWorkspace, tabById } from "../../workspace/store";
import sheetsSource from "../../workspace/files/sheets.tsx?raw";
import adviceSource from "../methodchooser/advice.ts?raw";
import { PANES } from "../settings/registry";
import { SettingsView, resetSchemaCache } from "../settings/SettingsView";
import { aboutOpen, resetAboutWindow } from "../about";
import { releaseNotesOpen, resetReleaseNotesWindow } from "../releasenotes";
import { Article, linkTarget } from "./Article";
import {
  capitalizedHeading, DEFAULT_TOPIC, dumpBlocks, duplicateKeys, HelpButton, HelpHost, HelpView, helpOpen, helpState, menuHelp, menuShortcuts, openHelp, parseMarkdown,
  plainText, printHelpToStatus, resetHelpWindow, selectedTopic, SETTINGS_HELP, settingsHelpTopic, showHelpTopic, toolShortcuts, topic, topicBlocks, TOPICS, topicSource,
  topicText, useHelpCommands, HELP_SECTIONS,
} from ".";
import { START_SECTIONS } from "./words";
import { matchingBlocks, matchRanges } from "./markdown";

const resaved = import.meta.glob("../../../golden/{2dtandem,5stationtandem.inf}/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const openExample = (stem: string) => addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: JSON.parse(resaved[`../../../golden/${stem}/resave.bnet`]) });

afterEach(() => {
  resetHelpWindow();
  resetAboutWindow();
  resetReleaseNotesWindow();
  resetSchemaCache();
  vi.restoreAllMocks();
});

async function backend(opts: MockOptions = {}) {
  mockTauri(defaultHandlers(opts));
  await loadKv();
}

function Commands() {
  useHelpCommands();
  return null;
}

async function show(opts: MockOptions = {}) {
  await backend(opts);
  return render(<HelpView />);
}

const sidebar = () => screen.getByRole("navigation", { name: "Qnet Help" });
const topicButtons = () => [...sidebar().querySelectorAll<HTMLElement>("[data-help-topic]")];
const pageTitle = () => screen.getByRole("heading", { level: 1 }).textContent;
const search = () => screen.getByRole("searchbox", { name: "Search Help" });
const log = (id: string = activeTab(getWorkspace()).id) => tabById(id)!.log;
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Every command item of a menu spec. */
function specItems(entries: SpecEntry[], out: { id: string; label: string; accel?: string }[] = []) {
  for (const e of entries) {
    if (e === "-" || "header" in e || "predefined" in e || "dynamic" in e) continue;
    if ("submenu" in e) specItems(e.items, out);
    else out.push(e);
  }
  return out;
}
const helpMenu = () => (MENU_SPEC.find((e) => e !== "-" && "submenu" in e && e.submenu === "Help") as { items: SpecEntry[] }).items;

describe("the Help topics", () => {
  it("are 2.1's eleven and 0.90.34's 31, in its groups and order, each with its article", () => {
    expect(TOPICS.filter((t) => !(START_SECTIONS as readonly string[]).includes(t.section)).map((t) => t.id)).toEqual([...METHOD_REFERENCE.flatMap((s) => s.topics.map(([id]) => id)), ...AI_PROVIDER_TOPICS.map(([id]) => id)]);
    expect([...new Set(TOPICS.map((t) => t.section))]).toEqual([...HELP_SECTIONS]);
    for (const t of TOPICS) {
      expect(topicSource(t.id), t.id).not.toBeNull();
      const blocks = topicBlocks(t.id);
      expect(blocks[0]?.kind, `${t.id} starts with its title`).toBe("title");
      expect(blocks.length, t.id).toBeGreaterThan(3);
      expect(t.label, t.id).toMatch(/^help_[a-z0-9_]+$/);
    }
    // The menu's titles are the manifest's.
    for (const [id, label] of [...METHOD_REFERENCE.flatMap((s) => s.topics), ...AI_PROVIDER_TOPICS]) expect(topic(id)?.title, id).toBe(label);
    expect(topic("sbd")).toMatchObject({ windowTitle: "SBD — Sequential Bottleneck Decomposition", subtitle: "BNAsbd · bna_sbd", label: "help_alg_sbd" });
    expect(menuHelp(topic("sbd")!)).toBe("SBD — Sequential Bottleneck Decomposition (BNAsbd · bna_sbd)");
    expect(menuHelp(topic("general")!)).toBe("General Preferences");
  });

  it("link only to topics that exist, and to nothing but help: and web addresses", () => {
    for (const t of TOPICS) {
      const walk = (run: import("./markdown").Inline[]) => {
        for (const i of run) {
          if (i.t === "link") {
            const target = linkTarget(i.href);
            expect(target, `${t.id}: ${i.href}`).not.toBeNull();
            if (target?.kind === "topic") expect(topic(target.id), `${t.id}: help:${target.id}`).toBeDefined();
          }
          if (i.t === "strong" || i.t === "em" || i.t === "link") walk(i.c);
        }
      };
      for (const b of topicBlocks(t.id)) {
        if ("inline" in b) walk(b.inline);
        if (b.kind === "table") [b.header, ...b.rows].flat().forEach(walk);
      }
    }
  });
});

describe("Markdown as typeset blocks", () => {
  const source = [
    "# QNA — QUEUEING NETWORK ANALYZER (BNAqna)",
    "",
    "## WHEN IT WORKS WELL",
    "",
    "Whitt's analyzer; see [RQNA](help:rqna) and the *recursion* in `bna_qna`,",
    "which is **exact** for Jackson networks: α\\_i.",
    "",
    "1. Solve the traffic equations.",
    "2. Iterate:",
    "",
    "   ```",
    "   c_a = sum w",
    "   ```",
    "",
    "   until it settles.",
    "",
    "- Café networks",
    "  - nested",
    "",
    "| Key | Command |",
    "|---|---|",
    "| ⌘N | New Network |",
    "",
    "---",
    "",
    "<script>window.hacked = true</script>",
    "",
    "<img src=x onerror=\"window.hacked = true\">",
  ].join("\n");

  it("makes a title, headlines, paragraphs, bullets with their markers and levels, code and tables (HELP-014…016)", () => {
    expect(dumpBlocks(parseMarkdown(source))).toBe(
      [
        "TITLE     | QNA — QUEUEING NETWORK ANALYZER (BNAqna)",
        "HEADLINE  | WHEN IT WORKS WELL",
        "PARA      | Whitt's analyzer; see RQNA and the recursion in bna_qna, which is exact for Jackson networks: α_i.",
        "BULLET0   | 1. Solve the traffic equations.",
        "BULLET0   | 2. Iterate:",
        "CODE      |",
        "          |   c_a = sum w",
        "PARA      | until it settles.",
        "BULLET0   | • Café networks",
        "BULLET1   | • nested",
        "TABLE     |",
        "          |   Key  Command",
        "          |   ---  -----------",
        "          |   ⌘N   New Network",
        "",
      ].join("\n"),
    );
  });

  it("prints as plain text in the shape of 0.90.34's help: underlined headings, markers, indented code", () => {
    expect(plainText(parseMarkdown(source))).toBe(
      [
        "QNA — QUEUEING NETWORK ANALYZER (BNAqna)",
        "========================================",
        "",
        "WHEN IT WORKS WELL",
        "------------------",
        "",
        "Whitt's analyzer; see RQNA and the recursion in bna_qna, which is exact for Jackson networks: α_i.",
        "",
        "  1. Solve the traffic equations.",
        "  2. Iterate:",
        "",
        "      c_a = sum w",
        "",
        "  until it settles.",
        "",
        "  • Café networks",
        "    • nested",
        "",
        "    Key  Command",
        "    ---  -----------",
        "    ⌘N   New Network",
        "",
      ].join("\n"),
    );
  });

  it("title-cases all-capitals headings, keeping short acronyms and lower-casing small words (HELP-017)", () => {
    expect(capitalizedHeading("WHEN IT WORKS WELL")).toBe("When It Works Well");
    expect(capitalizedHeading("WHAT IT IS")).toBe("What It Is");
    expect(capitalizedHeading("CONNECTING AN AI PROVIDER: LM STUDIO")).toBe("Connecting an AI Provider: LM Studio");
    expect(capitalizedHeading("QNA VS SBD AND THE LP")).toBe("QNA vs SBD and the LP");
    expect(capitalizedHeading("THE LOAD ROW")).toBe("The Load Row");
    expect(capitalizedHeading("WHEN IT DOESN'T WORK + ALTERNATIVES")).toBe("When It Doesn't Work + Alternatives");
    expect(capitalizedHeading("Mixed Case stays")).toBe("Mixed Case stays");
    expect(capitalizedHeading("1.")).toBe("1.");
  });

  it("renders links, emphasis and code as elements and never an article's HTML", () => {
    const onTopic = vi.fn();
    const onExternal = vi.fn();
    const blocks = parseMarkdown(`${source}\n\n[site](https://example.com/a) and [bad](javascript:alert(1)) and [file](file:///etc/passwd)`);
    const { container } = render(<Article blocks={blocks} query="" currentBlock={null} onTopic={onTopic} onExternal={onExternal} />);
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("When It Works Well");
    expect(container.querySelector("code")).toHaveTextContent("bna_qna");
    expect(container.querySelector("strong")).toHaveTextContent("exact");
    fireEvent.click(screen.getByText("RQNA"));
    expect(onTopic).toHaveBeenCalledWith("rqna");
    fireEvent.click(screen.getByText("site"));
    expect(onExternal).toHaveBeenCalledWith("https://example.com/a");
    // Anything else is text, not a link.
    expect(screen.getByText(/bad/).closest("a")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("help:qna")).toEqual({ kind: "topic", id: "qna" });
  });

  it("finds matches without regard to case or diacritics (HELP-010)", () => {
    expect(matchRanges("A Café, a CAFE", "cafe")).toEqual([[2, 6], [10, 14]]);
    expect(matchRanges("anything", "  ")).toEqual([]);
    const blocks = parseMarkdown(source);
    expect(matchingBlocks(blocks, "when it works")).toEqual([1]);
    expect(matchingBlocks(blocks, "c_a")).toEqual([5]);
    expect(matchingBlocks(blocks, "")).toEqual([]);
  });
});

describe("the Help window", () => {
  it("lists the topics under the seven groups with their captions, and opens on Start Here (HELP-002…005; 2.1)", async () => {
    await show();
    expect(within(sidebar()).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Start Here", "Results", "Concepts", "Infinite-Buffer Methods", "Finite-Buffer Methods", "Workflows", "AI Providers"]);
    expect(topicButtons().map((b) => b.dataset.helpTopic)).toEqual(TOPICS.map((t) => t.id));
    const qna = document.getElementById("help.topic.qna")!;
    expect(qna).toHaveAccessibleName("QNA");
    expect(within(qna).getByText("BNAqna · bna_qna")).toBeInTheDocument();
    expect(DEFAULT_TOPIC).toBe("startHere");
    expect(document.getElementById("help.topic.startHere")).toHaveAttribute("aria-current", "page");
    expect(pageTitle()).toBe(topicBlocks("startHere")[0].text);
  });

  it("shows a topic when its row is chosen, with the breadcrumb, and remembers it under help.lastTopic (HELP-011, SET-180)", async () => {
    await show();
    fireEvent.click(document.getElementById("help.topic.qna")!);
    expect(pageTitle()).toBe("QNA — QUEUEING NETWORK ANALYZER (BNAqna)");
    const crumb = document.querySelector(".help-crumb")!;
    expect(crumb).toHaveTextContent("Infinite-Buffer Methods·BNAqna · bna_qna");
    await waitFor(() => expect(getStateValue("help.lastTopic", null)).toBe("qna"));
    // All-capitals headings read in title case.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toContain("When It Works Well");
    // A topic without a caption has only its group in the breadcrumb.
    fireEvent.click(document.getElementById("help.topic.general")!);
    expect(crumb.textContent).toBe("Workflows");
  });

  it("reopens the last topic (HELP-002)", async () => {
    await show({ state: { "help.lastTopic": "testSets" } });
    expect(selectedTopic()).toBe("testSets");
    expect(document.getElementById("help.topic.testSets")).toHaveAttribute("aria-current", "page");
  });

  it("falls back to Start Here for a stored topic it doesn't know (HELP-002; 2.1)", async () => {
    await show({ state: { "help.lastTopic": "gcdg" } });
    expect(selectedTopic()).toBe("startHere");
    expect(document.getElementById("help.topic.startHere")).toHaveAttribute("aria-current", "page");
  });

  it("filters the sidebar by title, full title, caption or text, hides empty groups and counts the matches (HELP-006, HELP-007)", async () => {
    await show();
    expect(search()).toHaveAttribute("placeholder", "Search help");
    expect(search().closest(".help-search")).toHaveAttribute("title", "Filter topics by title or body text; matches are highlighted in the page (⌘F)");
    expect(screen.getByText("⌘F")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    // A caption (the solver binary).
    fireEvent.change(search(), { target: { value: "FBNAFM" } });
    expect(topicButtons().map((b) => b.dataset.helpTopic)).toContain("finiteElement");
    // A full title that the sidebar's title doesn't carry.
    fireEvent.change(search(), { target: { value: "sequential bottleneck" } });
    expect(topicButtons().map((b) => b.dataset.helpTopic)).toContain("sbd");
    // Body text only one topic has.
    fireEvent.change(search(), { target: { value: "sticky PAN" } });
    expect(topicButtons().map((b) => b.dataset.helpTopic)).toEqual(["keyboardShortcuts"]);
    expect(within(sidebar()).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Workflows"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 topic matches");
    fireEvent.change(search(), { target: { value: "anthropic" } });
    const n = topicButtons().length;
    expect(n).toBeGreaterThan(1);
    expect(screen.getByRole("status")).toHaveTextContent(`${n} topics match`);
    fireEvent.change(search(), { target: { value: "zzzqqq" } });
    expect(topicButtons()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("No topics match");
    expect(screen.getByText("No Results for “zzzqqq”")).toBeInTheDocument();
  });

  it("clears the search on Escape anywhere in the window (HELP-008)", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "spectral" } });
    const esc = fireEvent.keyDown(screen.getByRole("heading", { level: 1 }), { key: "Escape" });
    expect(esc, "the window does not also close").toBe(false);
    expect(search()).toHaveValue("");
    expect(topicButtons()).toHaveLength(TOPICS.length);
    // With nothing to clear, Escape is left to the window (it closes, KEY-030).
    expect(fireEvent.keyDown(search(), { key: "Escape" })).toBe(true);
  });

  it("marks every occurrence in the page, walks the matching blocks with wrap-around, and starts over on a new topic (HELP-010…013)", async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    await show();
    fireEvent.click(document.getElementById("help.topic.qna")!);
    expect(document.querySelector(".help-walker")).toBeNull();
    fireEvent.change(search(), { target: { value: "qna" } });
    const blocks = topicBlocks("qna");
    const matches = matchingBlocks(blocks, "qna");
    expect(matches.length).toBeGreaterThan(1);
    const marks = () => [...document.querySelectorAll("mark.help-mark")];
    expect(marks().length).toBeGreaterThanOrEqual(matches.length);
    expect(marks().every((m) => m.textContent!.toLowerCase() === "qna")).toBe(true);
    const current = () => document.querySelector("[data-current]")!.getAttribute("data-block");
    const count = () => document.querySelector(".help-walker-count")!;
    expect(count()).toHaveTextContent(`1 of ${matches.length}`);
    expect(count()).toHaveAccessibleName(`Match 1 of ${matches.length}`);
    expect(current()).toBe(String(matches[0]));
    // Only the block under the cursor takes the strong tint; the page scrolls to it.
    expect(marks().filter((m) => m.classList.contains("current")).every((m) => m.closest("[data-current]"))).toBe(true);
    expect(scrolled.at(-1)?.getAttribute("data-block")).toBe(String(matches[0]));
    const next = screen.getByRole("button", { name: "Find Next" });
    const prev = screen.getByRole("button", { name: "Find Previous" });
    expect(next).toHaveAttribute("title", "Scroll to the next match (⌘G)");
    expect(prev).toHaveAttribute("title", "Scroll to the previous match (⇧⌘G)");
    fireEvent.click(next);
    expect(count()).toHaveTextContent(`2 of ${matches.length}`);
    expect(current()).toBe(String(matches[1]));
    expect(scrolled.at(-1)?.getAttribute("data-block")).toBe(String(matches[1]));
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(count()).toHaveTextContent(`${matches.length} of ${matches.length}`);
    fireEvent.click(next);
    expect(count()).toHaveTextContent(`1 of ${matches.length}`);
    // Return and Shift-Return in the field step too.
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(count()).toHaveTextContent(`2 of ${matches.length}`);
    // Another topic: back to its first match.
    const other = topicButtons().find((b) => b.dataset.helpTopic !== "qna")!;
    fireEvent.click(other);
    expect(helpState().matchIndex).toBe(0);
    // Clearing the search leaves the page where it was.
    const before = scrolled.length;
    fireEvent.change(search(), { target: { value: "" } });
    expect(scrolled.length).toBe(before);
    expect(marks()).toHaveLength(0);
  });

  it("is where Edit ▸ Find, Find Next and Find Previous go while it has the keys (HELP-009, HELP-012, MENU-050)", async () => {
    await show();
    const h = handlersFor("window:help")!;
    expect(h.findTitle).toBe("Search Help…");
    expect(h.canStepFind!()).toBe(false);
    expect(paneWords.findStepHelp.help).toEqual(["Scroll to the next match in this help topic", "No matches in this help topic"]);
    expect(paneWords.findHelp.help).toBe("Move the keyboard focus to the Help window's search field");
    act(() => h.find!());
    await waitFor(() => expect(search()).toHaveFocus());
    fireEvent.click(document.getElementById("help.topic.qna")!);
    fireEvent.change(search(), { target: { value: "qna" } });
    expect(h.canStepFind!()).toBe(true);
    act(() => h.stepFind!(1));
    expect(document.querySelector(".help-walker-count")!.textContent).toMatch(/^2 of /);
    act(() => h.stepFind!(-1));
    act(() => h.stepFind!(-1));
    expect(helpState().matchIndex).toBe(matchingBlocks(topicBlocks("qna"), "qna").length - 1);
  });

  it("moves through the topics with the arrow keys", async () => {
    await show();
    fireEvent.keyDown(document.getElementById("help.topic.startHere")!, { key: "ArrowDown" });
    expect(selectedTopic()).toBe("solve");
    expect(document.getElementById("help.topic.solve")).toHaveFocus();
    fireEvent.keyDown(document.getElementById("help.topic.solve")!, { key: "ArrowUp" });
    fireEvent.keyDown(document.getElementById("help.topic.startHere")!, { key: "ArrowUp" });
    expect(selectedTopic()).toBe("startHere");
  });

  it("is one window, “Qnet Help” whatever the topic, 1040 × 704 and never smaller than 896 × 616 (HELP-001, HELP-020)", async () => {
    await backend();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    const opened = vi.spyOn(window, "open").mockImplementation(() => win);
    const focus = vi.spyOn(win, "focus").mockImplementation(() => {});
    render(
      <>
        <Commands />
        <HelpHost />
      </>,
    );
    await act(() => runCommand("help:open"));
    expect(opened).toHaveBeenCalledWith(expect.stringMatching(/^about:blank#aux=help&id=[a-z0-9]+&minw=896&minh=616$/), "qnet-help", "width=1040,height=704");
    const body = within(win.document.body);
    expect(await body.findByRole("searchbox", { name: "Search Help" })).toBeInTheDocument();
    expect(win.document.title).toBe("Qnet Help");
    // A second request shows the same window, at the topic asked for.
    act(() => void openHelp("ctmc"));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
    await waitFor(() => expect(body.getByRole("heading", { level: 1 })).toHaveTextContent(topicBlocks("ctmc")[0].text));
    expect(win.document.title).toBe("Qnet Help");
    expect(openHelp("noSuchTopic")).toBe(false);
    frame.remove();
  });

  it("opens at the saved size (SET-200)", async () => {
    await backend({ state: { "WindowFrame.QnetHelpWindow": "{{40, 60}, {1200, 800}}" } });
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const opened = vi.spyOn(window, "open").mockImplementation(() => frame.contentWindow!);
    render(<HelpHost />);
    act(() => void openHelp());
    expect(opened).toHaveBeenCalledWith(expect.any(String), "qnet-help", "width=1200,height=800");
    frame.remove();
  });
});

describe("where a Help-menu topic goes (help.outputDestination)", () => {
  it("is the Help window by default, at the topic (HELP-088, HELP-092)", async () => {
    await backend();
    render(<Commands />);
    expect(await runCommand("help:ref:qna")).toBe(true);
    expect(helpOpen()).toBe(true);
    expect(selectedTopic()).toBe("qna");
    expect(log()).toHaveLength(0);
    expect(mockHelp.shown).toHaveLength(0);
  });

  it("is the Status log between two dividers, a line an entry (HELP-090, LOG-029)", async () => {
    await backend();
    render(<Commands />);
    await act(() => setSettings({ "help.outputDestination": 0 }));
    expect(await runCommand("help:topic:connectOllama")).toBe(true);
    const entries = log();
    const lines = topicText("connectOllama").replace(/\n$/, "").split("\n");
    expect(entries.map((e) => e.text)).toEqual(["──── Connecting to Ollama ────", ...lines, "──── end ────"]);
    expect(entries.every((e) => e.severity === "info")).toBe(true);
    expect(lines[0]).toBe(topicBlocks("connectOllama")[0].text);
    expect(lines[1]).toBe("=".repeat([...lines[0]].length));
    expect(helpOpen()).toBe(false);
    // The Method Reference's ids and the provider items go the same way (HELP-093).
    await runCommand("help:ref:sbd");
    expect(log().map((e) => e.text)).toContain("──── SBD — Sequential Bottleneck Decomposition ────");
    expect(printHelpToStatus("noSuchTopic")).toBe(false);
  });

  it("is the Shell through the run path, under the topic's label, with no record (HELP-091, RUN-045)", async () => {
    await backend();
    render(<Commands />);
    const id = openExample("2dtandem");
    await act(() => setSettings({ "help.outputDestination": 1 }));
    const chunks: string[] = [];
    const methods: string[] = [];
    const stop = onRunOutput((bytes, meta) => {
      chunks.push(new TextDecoder().decode(bytes));
      methods.push(meta.method);
    });
    expect(await runCommand("help:ref:qna")).toBe(true);
    await waitFor(() => expect(getRunState().last?.summary).toBe("Help Alg Qna finished in 0.0 s"));
    stop();
    expect(mockHelp.shown).toEqual([{ tabId: id, title: "2dtandem.bnet", label: "help_alg_qna", text: topicText("qna") }]);
    expect(chunks.join("")).toBe(topicText("qna"));
    expect(new Set(methods)).toEqual(new Set(["help_alg_qna"]));
    // Prose keeps its numbers as written: nothing is normalised.
    expect(chunks.join("")).toContain("0.5 – 0.95");
    expect(getRunState().last?.recordId).toBeNull();
    expect(mockRuns.records).toHaveLength(0);
    expect(helpOpen()).toBe(false);
    expect(log(id).map((e) => e.text)).not.toContain("──── end ────");
  });

  it("is refused while a run is active, with the registry's sentence and a beep", async () => {
    await backend();
    render(<Commands />);
    const beep = vi.spyOn(editorFeedback, "beep").mockImplementation(() => {});
    mockRuns.replayMs = 10_000;
    try {
      const a = openExample("5stationtandem.inf");
      const b = openExample("2dtandem");
      await act(() => setSettings({ "help.outputDestination": 1 }));
      expect(await startRun(a, "qna")).toBe(true);
      expect(await showHelpTopic("keyboardShortcuts")).toBe(false);
      expect(log(b).map((e) => e.text)).toContain("Help Shortcuts was not started because QNA is already running for “5stationtandem.inf.bnet”. Stop or wait for that run first.");
      expect(beep).toHaveBeenCalledTimes(1);
      expect(mockHelp.shown).toHaveLength(0);
      await stopRun();
      await tick();
    } finally {
      mockRuns.replayMs = 120;
    }
  });

  it("is never asked by Help ▸ Qnet Help or by a window's help button: they open the window (HELP-093, HELP-095)", async () => {
    await backend();
    render(
      <>
        <Commands />
        <HelpButton topic="solverInputs" />
      </>,
    );
    await act(() => setSettings({ "help.outputDestination": 0 }));
    await act(() => runCommand("help:open"));
    expect(helpOpen()).toBe(true);
    resetHelpWindow();
    const button = screen.getByRole("button", { name: "Help about Solver Input Files" });
    expect(button).toHaveAttribute("title", "Open Qnet Help at “Solver Input Files”");
    fireEvent.click(button);
    expect(helpOpen()).toBe(true);
    expect(selectedTopic()).toBe("solverInputs");
    expect(log()).toHaveLength(0);
  });
});

describe("the Help menu's commands", () => {
  it("registers every id the menu names, so no Help item is dimmed (MENU-157…195)", async () => {
    await backend();
    render(<Commands />);
    // The Help area's own items: the dependency check, the failure reports and 2.1's welcome and tour items are other areas'.
    const own = (id: string) => /^help:(open$|topic:|ref:|release-notes$)/.test(id);
    const ids = specItems(helpMenu()).map((i) => i.id).filter(own);
    // Qnet Help and Release Notes; Keyboard Shortcuts, the MLMC guide and (2.1) Scripting with Python; the reference; the providers.
    expect(ids).toHaveLength(2 + 3 + 28 + 4);
    expect(ids).toContain("help:topic:scriptingPython");
    for (const id of ids) expect(getCommand(id), id).toBeDefined();
    const dimmed: string[] = [];
    const walk = (nodes: MenuNode[]) => nodes.forEach((n) => (n.type === "submenu" ? walk(n.items) : n.type === "item" && !n.enabled && own(n.id) ? dimmed.push(n.id) : undefined));
    walk(resolveMenu(helpMenu()));
    expect(dimmed).toEqual([]);
    // Every topic has its command; the Method Reference lists the four groups, not the providers.
    for (const t of TOPICS) expect(getCommand(`help:topic:${t.id}`), t.id).toBeDefined();
    expect(getCommands().filter((c) => c.id.startsWith("help:ref:")).map((c) => c.id.slice(9))).toEqual(METHOD_REFERENCE.flatMap((r) => r.topics.map(([id]) => id)));
    expect(getCommand("help:ref:connectOllama")).toBeUndefined();
  });

  it("carries 0.90.34's titles and tooltips (MENU-158…161, MENU-164)", async () => {
    await backend();
    render(<Commands />);
    expect(getCommand("help:open")).toMatchObject({ title: "Qnet Help", shortcut: "⌘?", subtitle: "Open the searchable Qnet Help window" });
    expect(getCommand("help:topic:keyboardShortcuts")).toMatchObject({ title: "Keyboard Shortcuts", subtitle: "Every key equivalent in the menu bar, plus the canvas keys that are not printed beside a menu item" });
    expect(getCommand("help:topic:exactSimulation")).toMatchObject({ title: "SRBM MLMC Guide", subtitle: "Open the SRBM MLMC topic (Settings ▸ Help chooses the window, Status pane or Shell)" });
    expect(getCommand("help:release-notes")).toMatchObject({ title: "Release Notes", subtitle: "What changed in this build and in every earlier release" });
    expect(getCommand("app:about")).toMatchObject({ title: "About Qnet", subtitle: "Version and build information" });
    expect(getCommand("help:ref:sbd")).toMatchObject({ title: "SBD", subtitle: "SBD — Sequential Bottleneck Decomposition (BNAsbd · bna_sbd)" });
    expect(getCommand("help:ref:spectralFinite")).toMatchObject({ title: "Spectral Method", subtitle: "Spectral Method (Finite Buffers) (fBNAsm · srbm_solver)" });
    expect(getCommand("help:topic:connectLMStudio")?.subtitle).toBe("Connecting to LM Studio");
  });

  it("opens each topic's article, Release Notes and About", async () => {
    await backend();
    render(<Commands />);
    for (const t of TOPICS) {
      expect(await runCommand(`help:topic:${t.id}`), t.id).toBe(true);
      expect(selectedTopic()).toBe(t.id);
    }
    await runCommand("help:ref:finiteLP");
    expect(selectedTopic()).toBe("finiteLP");
    expect(releaseNotesOpen()).toBe(false);
    await runCommand("help:release-notes");
    expect(releaseNotesOpen()).toBe(true);
    expect(aboutOpen()).toBe(false);
    await runCommand("app:about");
    expect(aboutOpen()).toBe(true);
    resetAboutWindow();
    await runCommand("help:acknowledgements");
    expect(aboutOpen()).toBe(true);
  });
});

describe("the help buttons of other windows", () => {
  it("each Settings pane's “?” opens its article (HELP-099, PLAN P7)", async () => {
    await backend();
    render(<SettingsView />);
    await screen.findByText("Qnet asks on the next launch whether to reopen the tabs that were open at quit.");
    expect(Object.keys(SETTINGS_HELP)).toEqual(PANES.map((p) => p.id));
    const settings = screen.getByRole("navigation", { name: "Settings" });
    for (const p of PANES) {
      fireEvent.click(within(settings).getAllByRole("listitem").find((b) => b.textContent === p.title)!);
      await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(p.title));
      const want = topic(settingsHelpTopic(p.id))!;
      expect(want, p.id).toBeDefined();
      const button = document.querySelector<HTMLElement>(".set-bar [data-help-button]")!;
      expect(button).toHaveAttribute("title", `Open Qnet Help at “${want.windowTitle}”`);
      resetHelpWindow();
      fireEvent.click(button);
      expect(helpOpen(), p.id).toBe(true);
      expect(selectedTopic(), p.id).toBe(want.id);
    }
    expect(settingsHelpTopic("Simulation")).toBe("simulationInfinite");
    expect(settingsHelpTopic("Interactive Shell Window")).toBe("interactiveShell");
    // AI Assistant opens the chosen provider's page.
    expect(settingsHelpTopic("AI Assistant")).toBe("connectAnthropic");
    await act(() => setSettings({ "ai.provider": "ollama" }));
    expect(settingsHelpTopic("AI Assistant")).toBe("connectOllama");
    await act(() => setSettings({ "ai.provider": "lmstudio" }));
    expect(settingsHelpTopic("AI Assistant")).toBe("connectLMStudio");
    // 2.1: OpenAI has its own article.
    await act(() => setSettings({ "ai.provider": "openai" }));
    expect(settingsHelpTopic("AI Assistant")).toBe("connectOpenAI");
  });

  it("every run-parameter panel and Method Chooser row names an article that exists, under a registered id (HELP-096…098)", async () => {
    await backend();
    render(<Commands />);
    const sheetTopics = [monteCarloInfinite(), monteCarloFinite(), regenerative(true), spectralInfinite(), spectralFinite(), finiteElement(2), multiClass(), linearProgram(2), comparisonBlocking()].map((s) => s.helpTopic);
    expect(new Set(sheetTopics)).toEqual(new Set(["simulationInfinite", "simulationFinite", "regenerativeSimulation", "spectralInfinite", "spectralFinite", "finiteElement", "multiClassSRBM", "linearProgramInfinite", "srbmHypercube"]));
    // The panels' footers run help:ref:<topic> (src/runs/ui/RunPanels.tsx); the Test panels' topic is testSets.
    for (const id of [...sheetTopics, "testSets"]) {
      expect(topic(id), id).toBeDefined();
      expect(getCommand(`help:ref:${id}`), id).toBeDefined();
      resetHelpWindow();
      await runCommand(`help:ref:${id}`);
      expect(selectedTopic()).toBe(id);
    }
    // The Method Chooser's rows: every id of its `HelpTopic` type is an article.
    const union = /export type HelpTopic =([^;]+);/.exec(adviceSource)![1];
    const chooserTopics = [...union.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(chooserTopics.length).toBeGreaterThan(10);
    for (const id of chooserTopics) expect(topic(id), id).toBeDefined();
  });

  it("the SRBM export sheet and Export All Solver Inputs link Solver Input Files (HELP-096, HELP-097)", () => {
    expect(sheetsSource.match(/helpTopic: "solverInputs"/g)).toHaveLength(2);
    expect(topic("solverInputs")?.windowTitle).toBe("Solver Input Files");
  });
});

describe("Help ▸ Keyboard Shortcuts", () => {
  it("lists every key the menu bar prints now, under its menu (KEY-035)", async () => {
    await backend();
    render(<Commands />);
    const text = topicText("keyboardShortcuts");
    const entries = menuShortcuts();
    const withKeys = specItems(MENU_SPEC).filter((i) => i.accel);
    expect(withKeys.length).toBeGreaterThan(60);
    for (const item of withKeys) {
      const key = shortcutFor(item.id);
      // A buffer-mode pair prints its key beside one of the two items only.
      if (!key) continue;
      expect(key).toBe(displayAccel(item.accel!));
      const found = entries.find((e) => e.id === item.id);
      expect(found, item.id).toMatchObject({ key });
      expect(found!.command.endsWith(item.label) || !!getCommand(item.id)?.dynamicTitle, item.id).toBe(true);
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text, item.id).toMatch(new RegExp(`^\\s+${esc(key)}\\s+${esc(found!.command)}$`, "m"));
    }
    // One section per menu, in the bar's order, each row "key  Submenu ▸ Item".
    const menus = MENU_SPEC.filter((e): e is Extract<SpecEntry, { submenu: string }> => e !== "-" && "submenu" in e).map((m) => m.submenu);
    expect([...new Set(entries.map((e) => e.menu))]).toEqual(menus.filter((m) => entries.some((e) => e.menu === m)));
    const headings = topicBlocks("keyboardShortcuts").filter((b) => b.kind === "headline").map((b) => b.text);
    for (const m of ["FILE", "EDIT", "VIEW", "RUN", "WINDOW", "HELP"]) expect(headings).toContain(m);
    expect(text).toMatch(/^\s+⌘N\s+New Network$/m);
    expect(text).toMatch(/^\s+⌘K\s+Shell ▸ Clear Shell$/m);
    expect(text).toMatch(/^\s+⌘\?\s+Qnet Help$/m);
    expect(text).toMatch(/^\s+⌘H\s+Hide Qnet$/m);
  });

  it("adds the keys no menu carries: the tool letters from the canvas, and the article's own list (KEY-036, KEY-038)", async () => {
    await backend();
    render(<Commands />);
    expect(toolShortcuts().map(([k]) => k).join(" ")).toBe("V M H S B O X L");
    const text = topicText("keyboardShortcuts");
    for (const [key, title] of toolShortcuts()) expect(text).toMatch(new RegExp(`^\\s+${key}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    const headings = topicBlocks("keyboardShortcuts").filter((b) => b.kind === "headline").map((b) => b.text);
    expect(headings[0]).toBe("CONVENTIONS");
    // The generated tables sit where the article marks them: after CONVENTIONS, before its hand-kept list.
    expect(headings.indexOf("FILE")).toBeGreaterThan(headings.indexOf("CONVENTIONS"));
    expect(headings.indexOf("CANVAS TOOLS")).toBeLessThan(headings.indexOf("KEYS NOT PRINTED IN A MENU"));
    expect(text).toContain("Esc (mid-drag)");
    expect(text).toContain("⌃⇥ / ⌃⇧⇥");
  });

  it("is rebuilt on every read, so it follows the menu, and no two items share a key", async () => {
    await backend();
    render(<Commands />);
    expect(duplicateKeys()).toEqual([]);
    const fake: MenuNode[] = [{ type: "submenu", label: "File", items: [{ type: "item", id: "a", label: "One", accel: "CmdOrCtrl+Shift+T", enabled: true }, { type: "submenu", label: "Export", items: [{ type: "item", id: "b", label: "Two…", accel: "CmdOrCtrl+Shift+T", enabled: true }] }] }];
    expect(menuShortcuts(fake)).toEqual([{ menu: "File", command: "One", key: "⇧⌘T", id: "a" }, { menu: "File", command: "Export ▸ Two…", key: "⇧⌘T", id: "b" }]);
    expect(duplicateKeys(menuShortcuts(fake))).toEqual(["⇧⌘T: File ▸ One and File ▸ Export ▸ Two…"]);
    expect(topicBlocks("keyboardShortcuts")).not.toBe(topicBlocks("keyboardShortcuts"));
    expect(topicBlocks("qna")).toBe(topicBlocks("qna"));
  });
});

describe("the palette's Help entries (the P7 review)", () => {
  it("list every topic once: a Method Reference topic under that menu's id only", async () => {
    const { helpCommands } = await import("./commands");
    const { TOPICS } = await import("./topics");
    const listed = helpCommands().filter((c) => !c.menuOnly && /^help:(topic|ref):/.test(c.id)).map((c) => c.id.replace(/^help:(topic|ref):/, ""));
    expect([...listed].sort()).toEqual(TOPICS.map((t) => t.id).sort());
  });
});
