// The AI Assistant pane's interface against the scripted provider: the backend states, the
// composer, the transcript, search, Clear, export and the header (AIPaneView.swift; ledger §13.6,
// §8.12, MENU-049, MENU-150, KEY-021…024).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockAi } from "../../dev/mock/ai";
import { getSetting, loadKv, setSettings } from "../../lib/kv";
import { mockCalls, mockTauri, type MockHandlers } from "../../test/tauri";
import { handlersFor } from "../../workspace/focus";
import { addTab, selectTab } from "../../workspace/store";
import { resetSettingsWindow, settingsOpen } from "../../windows/settings";
import { AIPane as PlacedAIPane } from "../../workspace/panes/Placeholders";
import { AIPane, aiLaunch, matches } from "./AIPane";
import { cancelRequest, conversationOf, draft, isBusy, resetAi, submit, whenIdle } from "./model";
import { call, textTurn, tick, toolTurn } from "./testing";
import { fenced, fullTime, transcriptFileName, transcriptMarkdown } from "./transcript";
import { aiWords as w } from "./words";

let tabId: string;
let clipboard = "";

async function start(settings: Record<string, unknown> = { "ai.provider": "ollama" }, files: MockHandlers = {}) {
  mockTauri({ ...defaultHandlers({ settings }), ...files });
  await loadKv();
  tabId = addTab({ title: "tandem.bnet" });
  const view = render(
    <>
      <AIPane />
      <DialogHost />
    </>,
  );
  await act(() => tick(0));
  return view;
}
const composer = () => screen.getByRole("textbox", { name: "Message to the AI assistant" }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send message" });
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const idle = () => act(async () => { await whenIdle(); await tick(0); });
const say = async (text: string) => {
  type(text);
  fireEvent.keyDown(composer(), { key: "Enter" });
  await idle();
};

beforeEach(() => {
  clipboard = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => ((clipboard = t), Promise.resolve()) } });
  aiLaunch.at = Date.now();
});
afterEach(() => {
  resetAi();
  resetSettingsWindow();
});

describe("backend states", () => {
  it("is the pane the workspace places (the placeholder is gone)", () => {
    expect(PlacedAIPane).toBe(AIPane);
  });

  it("with a local provider configured and nothing said, shows the starter panel; a prompt fills the composer (AI-085)", async () => {
    await start({ "ai.provider": "ollama", "ai.model.ollama": "llama3.2" });
    expect(screen.getByRole("heading", { name: "Ask llama3.2 about tandem.bnet" })).toBeInTheDocument();
    expect(screen.getByText("The assistant can read this tab's canvas, change it, and run any solver from the Run menu. Each tab keeps its own conversation.")).toBeInTheDocument();
    const prompts = within(screen.getByRole("group", { name: "No messages yet" })).getAllByRole("button");
    expect(prompts.map((b) => b.textContent)).toEqual(["Summarise this network", "Which stations are unstable?", "Run QNA and explain the ρ values"]);
    expect(prompts[2]).toHaveAttribute("title", "Put “Run QNA and explain the ρ values” in the message field");
    fireEvent.click(prompts[2]);
    expect(composer().value).toBe("Run QNA and explain the ρ values");
    expect(composer()).toHaveFocus();
    expect(composer()).toHaveAttribute("placeholder", "Ask about tandem.bnet…  (⇧↩ for a new line)");
    const chip = screen.getByRole("button", { name: "AI backend: Ollama, llama3.2, Ready" });
    expect(chip).toHaveTextContent("Ollama · llama3.2");
    expect(chip).toHaveAttribute("title", "Ollama · llama3.2\nStatus: Ready\nClick to open Settings ▸ AI Assistant");
    expect(chip).toHaveAttribute("data-status", "ready");
  });

  it("without a key for a provider that needs one, says so with a button into Settings ▸ AI (AI-086, AI-087, SET-215, KEY-024)", async () => {
    await start({ "ai.provider": "anthropic" });
    expect(screen.getByRole("heading", { name: "No AI Backend Configured" })).toBeInTheDocument();
    expect(screen.getByText("Anthropic needs an API key. Add it in Settings ▸ AI Assistant.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI backend: Anthropic, claude-opus-5-5, API key missing" })).toHaveTextContent("Anthropic · claude-opus-5-5 · no key");
    expect(composer()).toHaveAttribute("placeholder", "Configure a backend to start chatting");
    expect(settingsOpen()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open AI Settings…" }));
    expect(settingsOpen()).toBe(true);
    resetSettingsWindow();
    fireEvent.keyDown(document.body, { key: ",", metaKey: true, altKey: true });
    expect(settingsOpen()).toBe(true);
  });

  it("re-reads the key when the window comes back from Settings, and then offers the starter panel", async () => {
    await start({ "ai.provider": "openai" });
    expect(screen.getByRole("heading", { name: "No AI Backend Configured" })).toBeInTheDocument();
    mockAi.keys.openai = "sk-test";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await tick(0);
    });
    expect(screen.getByRole("heading", { name: "Ask gpt-6-astra about tandem.bnet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI backend: OpenAI, gpt-6-astra, Ready" })).toBeInTheDocument();
  });

  it("with no model chosen, is not configured (AI-086, AI-087)", async () => {
    await start({ "ai.provider": "lmstudio", "ai.model.lmstudio": "  " });
    expect(screen.getByText("Choose a provider and model in Settings ▸ AI Assistant to chat about the current network and run solvers by name.")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "AI backend: LM Studio, no model, Not configured" });
    expect(chip).toHaveTextContent("LM Studio · not configured");
    fireEvent.click(chip);
    expect(settingsOpen()).toBe(true);
  });
});

describe("the composer", () => {
  it("Return sends, ⇧Return does not, and Send is dimmed for blank text or while busy (AI-066, AI-069, KEY-022)", async () => {
    await start();
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", "Send (↩)");
    type("   ");
    expect(sendButton()).toBeDisabled();
    type("first line");
    expect(sendButton()).toBeEnabled();
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    expect(mockAi.requests).toHaveLength(0);
    mockAi.hold();
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(() => tick(0));
    expect(mockAi.requests).toHaveLength(1);
    expect(mockAi.requests[0].messages).toEqual([{ role: "user", text: "first line" }]);
    expect(composer().value).toBe("");
    type("next");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", "Send (↩) — waiting for the current reply");
    expect(screen.getByRole("button", { name: "AI backend: Ollama, llama3.2, Working" })).toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    cancelRequest();
    await idle();
  });

  it("Escape stops this tab's request, and otherwise leaves for the canvas (AI-036, AI-067, KEY-022)", async () => {
    await start();
    mockAi.script([{ kind: "text", delta: "Partial" }]);
    type("q");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(() => tick(10));
    expect(screen.getByLabelText("Assistant, streaming: Partial")).toHaveTextContent("Partial ▍");
    fireEvent.keyDown(composer(), { key: "Escape" });
    await idle();
    expect(isBusy()).toBe(false);
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    composer().focus();
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(isBusy()).toBe(false);
  });

  it("shows Stop only while a request runs; the button and ⌘. cancel it (AI-036, AI-038, AI-089, KEY-021)", async () => {
    await start();
    expect(screen.queryByRole("button", { name: "Stop request" })).toBeNull();
    mockAi.hold();
    type("q");
    fireEvent.click(sendButton());
    await act(() => tick(0));
    const stop = screen.getByRole("button", { name: "Stop request" });
    expect(stop).toHaveTextContent("Stop");
    expect(stop.getAttribute("title")).toMatch(/^Stop the current request \(.+, or Esc while the message field has focus\)$/);
    fireEvent.click(stop);
    await idle();
    expect(screen.queryByRole("button", { name: "Stop request" })).toBeNull();
    mockAi.hold();
    type("again");
    fireEvent.click(sendButton());
    await act(() => tick(0));
    fireEvent.keyDown(document.body, { key: ".", metaKey: true });
    await idle();
    expect(isBusy()).toBe(false);
    expect(screen.getAllByText("Stopped.")).toHaveLength(2);
  });

  it("takes the keyboard when shown after launch, and from Window ▸ Focus AI Input (AI-070, MENU-150)", async () => {
    await start();
    expect(composer()).not.toHaveFocus();
    act(() => handlersFor("ai")!.focus!());
    expect(composer()).toHaveFocus();
    resetAi();
    document.body.innerHTML = "";
  });

  it("takes the keyboard when the pane is shown more than two seconds after launch", async () => {
    aiLaunch.at = Date.now() - 5000;
    await start();
    expect(composer()).toHaveFocus();
  });
});

describe("the transcript", () => {
  it("draws user bubbles, Markdown replies, tool rows and notes (AI-071, AI-072, AI-075)", async () => {
    await start();
    mockAi.script(toolTurn(call("add_node", { kind: "station" }), call("delete_node", { name: "Nope" })), textTurn("Added **S1**.\n\n- one\n- two"));
    await say("add a station");
    const user = conversationOf(tabId).messages[0];
    expect(screen.getByText("add a station").closest(".ai-row")).toHaveAttribute("title", `Sent ${fullTime(user.timestamp)}`);
    expect(screen.getByText("S1").tagName).toBe("STRONG");
    expect(screen.getByText("one").closest(".ai-row")!.getAttribute("title")).toMatch(/^Received /);

    const ok = screen.getByRole("button", { name: "Tool call add_node, completed" });
    const bad = screen.getByRole("button", { name: "Tool call delete_node, failed" });
    expect(ok).toHaveTextContent("add_node");
    expect(ok).toHaveTextContent("kind=station");
    expect(ok.textContent).toMatch(/\d+ ms$/);
    expect(ok.getAttribute("title")).toMatch(/^add_node — completed in \d+ ms$/);
    expect(ok).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(ok);
    expect(screen.getByLabelText("Input to add_node")).toHaveTextContent('"kind" : "station"');
    expect(screen.getByLabelText("Result from add_node")).toHaveTextContent('Added station "S1".');
    fireEvent.click(bad);
    expect(screen.getByLabelText("Error from delete_node")).toHaveTextContent('Invalid tool input: No node named "Nope". Existing nodes: S1.');
    expect(within(bad.closest(".ai-tool") as HTMLElement).getByText("Error")).toBeInTheDocument();
  });

  it("shows an error as a ⚠ note in the warning colour, and the pause note with a Continue button (AI-029, AI-039)", async () => {
    await start();
    mockAi.script([{ kind: "error", message: "Ollama is not running at http://localhost:11434." }]);
    await say("hello");
    const note = screen.getByText("⚠ Ollama is not running at http://localhost:11434.");
    expect(note).toHaveAttribute("data-warning");
    expect(screen.queryByRole("button", { name: /Retry|Regenerate/ })).toBeNull();

    for (let i = 0; i < 11; i++) mockAi.script(toolTurn(call("read_status")));
    mockAi.script(textTurn("done"));
    await say("loop");
    expect(screen.getByText(w.paused(10))).not.toHaveAttribute("data-warning");
    const go = screen.getByRole("button", { name: "Continue the assistant's work" });
    expect(go).toHaveTextContent("Continue");
    fireEvent.click(go);
    await idle();
    expect(screen.queryByRole("button", { name: "Continue the assistant's work" })).toBeNull();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("copies one message from its context menu, and the conversation from the background's (AI-078)", async () => {
    await start();
    mockAi.script(textTurn("Reply text."));
    await say("question");
    fireEvent.contextMenu(screen.getByText("Reply text."));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Message" }));
    await waitFor(() => expect(clipboard).toBe("Reply text."));
    fireEvent.contextMenu(screen.getByRole("log"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Copy Conversation", "Save Transcript…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Conversation" }));
    await waitFor(() => expect(clipboard).toContain("## You · "));
  });

  it("swaps with the tab, says where a request is running, and holds Send meanwhile (AI-064, AI-068, AI-088)", async () => {
    await start();
    mockAi.script(textTurn("About tandem."));
    await say("first tab question");
    const other = addTab({ title: "other.bnet" }, { activate: false });
    selectTab(tabId);
    mockAi.hold();
    type("slow one");
    fireEvent.click(sendButton());
    await act(() => tick(0));
    act(() => selectTab(other));
    expect(screen.queryByText("first tab question")).toBeNull();
    expect(screen.getByLabelText("Conversation about other.bnet")).toHaveTextContent("other.bnet");
    expect(screen.getByLabelText("Working on tandem.bnet in another tab")).toHaveTextContent("Working on tandem.bnet");
    expect(screen.getByRole("button", { name: "AI backend: Ollama, llama3.2, Ready" })).toBeInTheDocument();
    expect(composer()).toHaveAttribute("placeholder", "Waiting for the request in “tandem.bnet” to finish…");
    type("me too");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", "Send (↩) — available once the request running for “tandem.bnet” finishes, or after Stop");
    const stop = screen.getByRole("button", { name: "Stop the request running for tandem.bnet" });
    expect(stop.getAttribute("title")).toMatch(/^Stop the request running for “tandem.bnet” \(not this tab's conversation\)/);
    fireEvent.click(stop);
    await idle();
    expect(screen.queryByLabelText("Working on tandem.bnet in another tab")).toBeNull();
    act(() => selectTab(tabId));
    expect(screen.getByText("first tab question")).toBeInTheDocument();
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
  });
});

describe("search", () => {
  const seed = async () => {
    await start();
    mockAi.script(toolTurn(call("add_node", { kind: "station", name: "Mill" })), textTurn("The mill is added."));
    await say("Add a station called Mill");
    mockAi.script(textTurn("Utilisation is 0.8."));
    await say("What is rho?");
  };

  it("registers Search Conversation… for ⌘F and steps with ⌘G (AI-079, MENU-049)", async () => {
    await seed();
    const h = handlersFor("ai")!;
    expect(h.findTitle).toBe("Search Conversation…");
    expect(h.canStepFind!()).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Search the conversation" })).toBeNull();
    act(() => h.find!());
    const field = screen.getByRole("textbox", { name: "Search the conversation" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute("placeholder", "Search conversation");
    fireEvent.change(field, { target: { value: "mill" } });
    // The user's message, the tool row (its input) and the reply match; the rest is filtered out.
    expect(screen.getByRole("log").querySelectorAll("[data-message].ai-message")).toHaveLength(3);
    expect(screen.queryByText("What is rho?")).toBeNull();
    expect([...screen.getByRole("log").querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Mill", "Mill", "mill"]);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(handlersFor("ai")!.canStepFind!()).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("log").querySelectorAll(".ai-message")[1]).toHaveAttribute("data-current");
    act(() => handlersFor("ai")!.stepFind!(1));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    act(() => handlersFor("ai")!.stepFind!(1));
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    act(() => handlersFor("ai")!.stepFind!(-1));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("shows No Results for a query nothing matches, and Escape closes the search (AI-080, KEY-023)", async () => {
    await seed();
    fireEvent.click(screen.getByRole("button", { name: "Search Conversation" }));
    const field = screen.getByRole("textbox", { name: "Search the conversation" });
    fireEvent.change(field, { target: { value: "  zebra " } });
    expect(screen.getByRole("heading", { name: "No Results for “zebra”" })).toBeInTheDocument();
    expect(screen.getByText("Check the spelling or try a different search.")).toBeInTheDocument();
    expect(handlersFor("ai")!.canStepFind!()).toBe(false);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Search the conversation" })).toBeNull();
    expect(screen.getByText("What is rho?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search Conversation" }));
    expect((screen.getByRole("textbox", { name: "Search the conversation" }) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Close Search" }));
    expect(screen.queryByRole("textbox", { name: "Search the conversation" })).toBeNull();
  });

  it("matches a tool row by its name, input or result, without regard to case", () => {
    const base = { id: "x", timestamp: 0, isStreaming: false, action: null };
    const tool = { ...base, role: "tool" as const, text: "", call: { name: "add_node", inputText: '{\n  "kind" : "station"\n}', inputSummary: "", result: 'Added station "S1".', isError: false, started: 0, finished: 1 } };
    expect(["ADD_NODE", "Station", "added", "s1"].map((q) => matches(tool, q))).toEqual([true, true, true, true]);
    expect(matches(tool, "sink")).toBe(false);
    expect(matches({ ...base, role: "user", text: "Hello There", call: null }, "hello t")).toBe(true);
  });
});

describe("Clear Conversation", () => {
  it("clears a short conversation at once, and is dimmed when empty or while this tab's request runs (AI-081)", async () => {
    await start();
    const clear = () => screen.getByRole("button", { name: "Clear Conversation" });
    expect(clear()).toBeDisabled();
    mockAi.script(textTurn("a"));
    await say("q");
    expect(clear()).toHaveAttribute("title", "Clear the conversation…");
    mockAi.hold();
    type("q2");
    fireEvent.click(sendButton());
    await act(() => tick(0));
    expect(clear()).toBeDisabled();
    expect(clear()).toHaveAttribute("title", "Stop the request before clearing the conversation");
    cancelRequest();
    await idle();
    fireEvent.click(clear());
    await act(() => tick(0));
    expect(conversationOf(tabId)).toEqual({ messages: [], history: [] });
    expect(screen.getByRole("heading", { name: "Ask llama3.2 about tandem.bnet" })).toBeInTheDocument();
  });

  it("asks first once there are more than four exchanges (AI-081)", async () => {
    await start();
    for (const q of ["1", "2", "3"]) {
      mockAi.script(textTurn(`answer ${q}`));
      await say(q);
    }
    fireEvent.click(screen.getByRole("button", { name: "Clear Conversation" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Clear the conversation?");
    expect(dialog).toHaveTextContent("All 6 messages and the assistant's context will be discarded. Save Transcript… keeps a copy first.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(() => tick(0));
    expect(conversationOf(tabId).messages).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Clear Conversation" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear Conversation" }));
    await waitFor(() => expect(conversationOf(tabId).messages).toHaveLength(0));
  });
});

describe("export", () => {
  it("keeps a tool result that holds its own code fence, and a note of several lines, inside their blocks (the second P7 review)", () => {
    const at = new Date(2026, 10, 11, 15, 4, 5).getTime();
    const base = { isStreaming: false, action: null, call: null, timestamp: at };
    const result = "before\n```\n## You · forged\n```\nafter";
    const text = transcriptMarkdown(
      [
        { ...base, id: "1", role: "tool", text: "", call: { name: "read_status", inputText: "{}", inputSummary: "", result, isError: false, started: at, finished: at } },
        { ...base, id: "2", role: "system", text: "⚠ first line\nsecond line" },
      ],
      at,
    );
    // The result sits in a four-backtick fence, so its own three-backtick lines can't close it.
    expect(text).toContain("**Result**\n\n````\n" + result + "\n````\n\n");
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(fenced("a ````` b", "json")).toBe("``````json\na ````` b\n``````");
    expect(text).toContain("> _⚠ first line_\n> _second line_\n\n");
  });

  it("writes the transcript as 0.90.34's Markdown (AI-084, FILE-064)", () => {
    const at = new Date(2026, 10, 11, 15, 4, 5).getTime();
    const base = { isStreaming: false, action: null, call: null, timestamp: at };
    const text = transcriptMarkdown(
      [
        { ...base, id: "1", role: "user", text: "Add a station" },
        { ...base, id: "2", role: "tool", text: "", call: { name: "add_node", inputText: '{\n  "kind" : "station"\n}', inputSummary: "kind=station", result: 'Added station "S1".', isError: false, started: at, finished: at + 12 } },
        { ...base, id: "3", role: "tool", text: "", call: { name: "delete_node", inputText: "{}", inputSummary: "", result: "Invalid tool input: `name` is required.", isError: true, started: at, finished: at + 1500 } },
        { ...base, id: "4", role: "assistant", text: "Added **S1**." },
        { ...base, id: "5", role: "system", text: "Stopped." },
      ],
      at,
    );
    const when = fullTime(at);
    expect(text).toBe(
      `# Qnet AI Assistant transcript\n\n_Exported ${when}_\n\n` +
        `## You · ${when}\n\nAdd a station\n\n` +
        `### Tool: \`add_node\` · ${when} · 12 ms\n\n**Input**\n\n\`\`\`json\n{\n  "kind" : "station"\n}\n\`\`\`\n\n**Result**\n\n\`\`\`\nAdded station "S1".\n\`\`\`\n\n` +
        `### Tool: \`delete_node\` · ${when} · 1.5 s\n\n**Input**\n\n\`\`\`json\n{}\n\`\`\`\n\n**Error**\n\n\`\`\`\nInvalid tool input: \`name\` is required.\n\`\`\`\n\n` +
        `## Assistant · ${when}\n\nAdded **S1**.\n\n` +
        `> _Stopped._\n\n`,
    );
    expect(transcriptFileName(Date.UTC(2026, 10, 11, 12))).toBe("Qnet AI transcript 2026-11-11.md");
  });

  it("offers Copy Conversation and Save Transcript… once something has been said (AI-082, AI-083)", async () => {
    let asked: { title?: string; defaultPath?: string; filters?: { extensions: string[] }[] } | undefined;
    const written: Record<string, string> = {};
    await start(undefined, {
      "plugin:dialog|save": ({ options }: { options: typeof asked }) => ((asked = options), "/Users/me/Desktop/t.md"),
      status_log_write: ({ path, text }: { path: string; text: string }) => ((written[path] = text), path),
    });
    const exportButton = () => screen.getByRole("button", { name: "Export conversation" });
    expect(exportButton()).toBeDisabled();
    mockAi.script(textTurn("An answer."));
    await say("A question");
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Copy Conversation", "Save Transcript…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Conversation" }));
    const expected = () => transcriptMarkdown(conversationOf(tabId).messages).replace(/_Exported .*_/, "");
    await waitFor(() => expect(clipboard.replace(/_Exported .*_/, "")).toBe(expected()));
    expect(clipboard).toContain("## You · ");
    expect(clipboard).toContain("\n\nA question\n\n## Assistant · ");

    fireEvent.click(exportButton());
    fireEvent.click(screen.getByRole("menuitem", { name: "Save Transcript…" }));
    await waitFor(() => expect(Object.keys(written)).toEqual(["/Users/me/Desktop/t.md"]));
    expect(asked).toMatchObject({ title: "Save Transcript", filters: [{ extensions: ["md"] }] });
    expect(asked!.defaultPath).toMatch(/^Qnet AI transcript \d{4}-\d{2}-\d{2}\.md$/);
    expect(written["/Users/me/Desktop/t.md"].replace(/_Exported .*_/, "")).toBe(expected());
  });

  it("puts a failed save in the transcript, and writes nothing when the panel is cancelled (FILE-065)", async () => {
    let answer: string | null = null;
    await start(undefined, {
      "plugin:dialog|save": () => answer,
      status_log_write: () => {
        throw { kind: "failed", message: "Permission denied (os error 13)" };
      },
    });
    mockAi.script(textTurn("An answer."));
    await say("A question");
    fireEvent.click(screen.getByRole("button", { name: "Export conversation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save Transcript…" }));
    await act(() => tick(5));
    expect(mockCalls.some((c) => c.cmd === "status_log_write")).toBe(false);
    answer = "/readonly/t.md";
    fireEvent.click(screen.getByRole("button", { name: "Export conversation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save Transcript…" }));
    expect(await screen.findByText("⚠ Could not save the transcript: Permission denied (os error 13)")).toHaveAttribute("data-warning");
  });
});

describe("the header's font controls", () => {
  it("steps the text size within 8–28 from the stepper and the pane zoom commands (AI-090)", async () => {
    await start({ "ai.provider": "ollama", "ai.fontSize": 27 });
    const bigger = screen.getByRole("button", { name: "Increase Text Size" });
    fireEvent.click(bigger);
    await waitFor(() => expect(getSetting("ai.fontSize", 0)).toBe(28));
    await waitFor(() => expect(bigger).toBeDisabled());
    expect(handlersFor("ai")!.canZoom!(1)).toBe(false);
    expect(handlersFor("ai")!.canZoom!(-1)).toBe(true);
    act(() => handlersFor("ai")!.zoom!(-1));
    await waitFor(() => expect(getSetting("ai.fontSize", 0)).toBe(27));
    await waitFor(() => expect(screen.getByRole("region", { name: "AI Assistant" }).style.getPropertyValue("--ai-fs")).toBe("27px"));
  });

  it("chooses the code font from the menu; empty is the system monospaced font (AI-090)", async () => {
    await start();
    const menu = screen.getByRole("button", { name: "Code Font: System Monospaced" });
    expect(menu).toHaveAttribute("title", "Code font (fenced code and tool output; prose uses the system font)");
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("menuitem", { name: /Menlo/ }));
    await waitFor(() => expect(getSetting("ai.fontName", "")).toBe("Menlo"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Code Font: Menlo" })).toBeInTheDocument());
    expect(screen.getByRole("region", { name: "AI Assistant" }).style.getPropertyValue("--ai-mono")).toBe('"Menlo", var(--mono)');
    await setSettings({ "ai.fontName": "" });
  });

  it("keeps 0.90.34's control order, and folds the font controls into one menu below 380 pt (AI-089)", async () => {
    await start();
    mockAi.hold();
    submit(tabId, "q");
    await act(() => tick(0));
    const labels = [...document.querySelectorAll(".pane-header-trailing button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Stop request", "Search Conversation", "Export conversation", "Code Font: System Monospaced", "Decrease Text Size", "Increase Text Size", "Clear Conversation", "Maximize AI Assistant Pane"]);
    cancelRequest();
    await idle();
  });

  it("when narrow, hides the network badge and offers More AI pane controls (AI-089)", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    try {
      await start();
      await act(() => tick(0));
      expect(screen.queryByLabelText("Conversation about tandem.bnet")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Code Font/ })).toBeNull();
      const more = screen.getByRole("button", { name: "More AI pane controls" });
      expect(more).toHaveAttribute("title", "Code font and text size");
      fireEvent.click(more);
      const items = screen.getAllByRole("menuitem").map((i) => i.textContent!.trim());
      expect(items.slice(0, 3)).toEqual(["Increase Text Size", "Decrease Text Size", "✓ System Monospaced"]);
      expect(draft()).toBe("");
    } finally {
      width.mockRestore();
    }
  });
});

describe("following the transcript", () => {
  it("offers Scroll to latest message once the reader has scrolled away from the end (AI-077)", async () => {
    await start();
    mockAi.script(textTurn("An answer."));
    await say("A question");
    const log = screen.getByRole("log");
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).toBeNull();
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 700;
    fireEvent.scroll(log);
    const latest = screen.getByRole("button", { name: "Scroll to latest message" });
    log.scrollTop = 780;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Scroll to latest message" })).toBeNull();
    log.scrollTop = 0;
    fireEvent.scroll(log);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));
    expect(log.scrollTop).toBe(1000);
    expect(latest).not.toBeInTheDocument();
  });
});

describe("⌘. while a solver run is active", () => {
  it("belongs to Run ▸ Stop: the request goes on, and the Stop tooltip says so (AI-038, KEY-021)", async () => {
    const { mockRuns } = await import("../../dev/mock/runs");
    const { startRun } = await import("../../runs/state");
    await start();
    const runTab = addTab({ title: "5stationtandem.inf.bnet" }, { activate: false });
    mockRuns.replayMs = 150;
    mockAi.hold();
    type("q");
    fireEvent.click(sendButton());
    await act(async () => {
      await startRun(runTab, "qna");
      await tick(0);
    });
    const stop = screen.getByRole("button", { name: "Stop request" });
    expect(stop.getAttribute("title")).toMatch(/^Stop the current request \(Esc while the message field has focus; .+ is stopping QNA right now\)$/);
    fireEvent.keyDown(document.body, { key: ".", metaKey: true });
    await act(() => tick(5));
    expect(isBusy()).toBe(true);
    await act(() => tick(250));
    mockRuns.replayMs = 120;
    fireEvent.keyDown(document.body, { key: ".", metaKey: true });
    await idle();
    expect(isBusy()).toBe(false);
  });
});
