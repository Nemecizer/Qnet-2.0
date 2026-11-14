// Settings ▸ AI Assistant's Model list for the cloud providers (2.1, ledger AI-207…AI-209): the
// built-in current list without a key or a refresh, the live list merged in after Refresh, and
// the note for a retired or deprecated stored model. The preview backend plays the server.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers, type MockOptions } from "../../dev/mockBackend";
import { mockAi } from "../../dev/mock/ai";
import { getSetting } from "../../lib/kv";
import { mockTauri } from "../../test/tauri";
import { CATALOG, CATALOG_DEFAULT, modelAdvice, pickerSections } from "../../panes/ai/catalog";
import { SETTINGS_DEFAULTS } from "../../dev/mock/kv";
import { resetSettingsWindow } from ".";
import { SettingsView, resetSchemaCache } from "./SettingsView";
import { resetKeys } from "./registry";

afterEach(() => {
  resetSchemaCache();
  resetSettingsWindow();
});

async function showAi(settings: MockOptions["settings"] = {}) {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "anthropic", ...settings }, state: { "settings.selectedPane": "AI Assistant" } }));
  render(
    <>
      <SettingsView />
      <DialogHost />
    </>,
  );
  await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("AI Assistant"));
  await waitFor(() => expect(getSetting("ai.provider", null)).not.toBeNull());
}

/** The Model list's sections as shown: [title, item labels]. */
function openModelList(): [string, string[]][] {
  fireEvent.click(screen.getByRole("button", { name: "Model list" }));
  const menu = screen.getByRole("menu");
  return [...menu.querySelectorAll(".set-menu-section")].map((s) => [
    s.querySelector(".set-menu-title")?.textContent ?? "",
    within(s as HTMLElement).queryAllByRole("menuitem").map((b) => b.textContent ?? ""),
  ]);
}

const WORDS = { current: "Current", older: "Older", account: "Account", deprecated: (l: string) => `${l} (deprecated)` };

describe("the built-in model lists", () => {
  it("default to the current recommended models, as the schema and the preview do", () => {
    expect(CATALOG_DEFAULT).toEqual({ anthropic: "claude-opus-5-5", openai: "gpt-6-astra" });
    expect(SETTINGS_DEFAULTS["ai.model.anthropic"]).toBe("claude-opus-5-5");
    expect(SETTINGS_DEFAULTS["ai.model.openai"]).toBe("gpt-6-astra");
    expect(SETTINGS_DEFAULTS["ai.fallback.anthropic"]).toBe(true);
    expect(CATALOG.anthropic![0].id).toBe("claude-opus-5-5");
    expect(CATALOG.openai!.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
    // No date-suffixed Claude ids, none listed twice.
    const ids = CATALOG.anthropic!.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => /\d{8}$/.test(id))).toEqual([]);
  });

  it("merge with a live list: the live list decides what is listed, the catalog's order and labels lead, unknown ids follow", () => {
    expect(pickerSections("anthropic", [], WORDS).map((s) => s.title)).toEqual(["Current", "Older"]);
    const live = pickerSections("anthropic", ["claude-zeta-9", "claude-sonnet-4-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-alpha-1"], WORDS);
    expect(live).toEqual([
      {
        title: "Account",
        items: [
          { label: "Claude Opus 5.5 — recommended", value: "claude-opus-5-5" },
          { label: "Claude Haiku 5.5 — fastest, lowest cost", value: "claude-haiku-5-5" },
          { label: "Claude Sonnet 4.5 (deprecated)", value: "claude-sonnet-4-5" },
          { label: "claude-alpha-1", value: "claude-alpha-1" },
          { label: "claude-zeta-9", value: "claude-zeta-9" },
        ],
      },
    ]);
  });

  it("know which stored Claude models are retired or deprecated, and what replaces them", () => {
    expect(modelAdvice("anthropic", "claude-3-5-sonnet-20241022")).toEqual({ kind: "retired", replacement: "claude-sonnet-5-5" });
    expect(modelAdvice("anthropic", "claude-3-haiku-20240307")).toEqual({ kind: "retired", replacement: "claude-haiku-5-5" });
    expect(modelAdvice("anthropic", "claude-3-opus-latest")).toEqual({ kind: "retired", replacement: "claude-opus-5-5" });
    expect(modelAdvice("anthropic", "claude-sonnet-4-20250514")).toEqual({ kind: "retired", replacement: "claude-sonnet-5-5" });
    expect(modelAdvice("anthropic", "claude-opus-4-20250514")).toEqual({ kind: "retired", replacement: "claude-opus-5-5" });
    expect(modelAdvice("anthropic", "claude-opus-4-1-20250805")).toEqual({ kind: "retired", replacement: "claude-opus-5-5" });
    expect(modelAdvice("anthropic", "claude-sonnet-4-5")).toEqual({ kind: "deprecated", replacement: "claude-sonnet-5-5", retires: "30 November 2026" });
    for (const current of ["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "my-proxy-model", "claude-30"]) expect(modelAdvice("anthropic", current)).toBeNull();
    expect(modelAdvice("openai", "claude-3-opus")).toBeNull();
  });
});

describe("Settings ▸ AI Assistant's Model list", () => {
  it("offers Anthropic's current models with no key and no refresh", async () => {
    await showAi();
    const sections = openModelList();
    expect(sections[0]).toEqual(["Current Models (November 2026)", ["Claude Opus 5.5 — recommended", "Claude Fable 5.2 — most capable", "Claude Sonnet 5.5 — faster, lower cost", "Claude Haiku 5.5 — fastest, lowest cost"]]);
    expect(sections[1][0]).toBe("Older Models, Still Available");
    expect(sections[1][1]).toContain("Claude Sonnet 4.5 — deprecated");
    expect(sections.at(-1)).toEqual(["", ["Reset to default (claude-opus-5-5)"]]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude Fable 5.2 — most capable" }));
    await waitFor(() => expect(getSetting("ai.model.anthropic", "")).toBe("claude-fable-5-2"));
    expect(mockAi.modelCalls).toEqual([]);
  });

  it("offers OpenAI's current models with no key and no refresh", async () => {
    await showAi({ "ai.provider": "openai" });
    expect(openModelList()[0]).toEqual(["Current Models (November 2026)", ["GPT-6 Astra — most capable", "GPT-6.1 Sol — near-Astra, lower cost", "GPT-6.1 Terra — fast and efficient", "GPT-6 Luna — most efficient"]]);
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveAttribute("placeholder", "gpt-6-astra");
  });

  it("after Refresh lists the account's models, with the server's display name for one the catalog lacks", async () => {
    await showAi();
    mockAi.keys.anthropic = "sk-ant";
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await waitFor(() => expect(getSetting("ai.discovered.anthropic", "")).not.toBe(""));
    const [account] = openModelList();
    expect(account).toEqual([
      "Available to Your Account",
      ["Claude Opus 5.5 — recommended", "Claude Fable 5.2 — most capable", "Claude Sonnet 5.5 — faster, lower cost", "Claude Haiku 5.5 — fastest, lowest cost", "Claude Sonnet 4.5 — deprecated", "Claude Mythos 5.2 (claude-mythos-5-2)"],
    ]);
  });

  it("leaves a stored retired model alone and suggests its replacement", async () => {
    await showAi({ "ai.model.anthropic": "claude-3-5-sonnet-20241022" });
    expect(await screen.findByText(/claude-3-5-sonnet-20241022 has been retired by Anthropic and no longer answers\. Its current replacement is claude-sonnet-5-5/)).toBeInTheDocument();
    expect(getSetting("ai.model.anthropic", "")).toBe("claude-3-5-sonnet-20241022");
  });

  it("notes a deprecated model's retirement, and says nothing for a current one", async () => {
    await showAi({ "ai.model.anthropic": "claude-sonnet-4-5" });
    expect(await screen.findByText("claude-sonnet-4-5 is deprecated and retires on 30 November 2026. Its replacement is claude-sonnet-5-5.")).toBeInTheDocument();
  });

  it("says the temperature is sent only where accepted, and has the refusal-fallback switch for Anthropic only", async () => {
    await showAi();
    expect(screen.getByText("Sent only to models that accept it: current Claude and GPT models choose their own and are sent none.")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "If Claude declines, let another Claude model answer" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(getSetting("ai.fallback.anthropic", true)).toBe(false));
    expect(resetKeys("AI Assistant", "anthropic")).toContain("ai.fallback.anthropic");
    expect(resetKeys("AI Assistant", "openai")).not.toContain("ai.fallback.anthropic");
  });

  it("has no fallback switch for another provider", async () => {
    await showAi({ "ai.provider": "openai" });
    expect(screen.queryByRole("switch", { name: "If Claude declines, let another Claude model answer" })).toBeNull();
  });
});
