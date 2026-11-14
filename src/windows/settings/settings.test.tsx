// The Settings window against the preview backend: its panes, search, Reset to Defaults, number
// fields, a value Rust refuses, Export… / Import…, Reset All, ⌘F and Qnet ▸ Settings….
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers, type MockOptions } from "../../dev/mockBackend";
import { mockInfo } from "../../dev/mock/core";
import { settingsFiles } from "../../dev/mock/settings";
import { SETTINGS_DEFAULTS } from "../../dev/mock/kv";
import { getSetting, getStateValue } from "../../lib/kv";
import { runCommand } from "../../lib/commands";
import { handlersFor } from "../../workspace/focus";
import { extendMock, mockCalls, mockTauri } from "../../test/tauri";
import { openSettings, resetSettingsWindow, SettingsHost, useSettingsCommands } from ".";
import { SettingsView, resetSchemaCache } from "./SettingsView";
import { displayName, ENTRIES, keysFor, matches, PANES, resetKeys, UNINDEXED_KEYS } from "./registry";
import { rows } from "./words";

afterEach(() => {
  resetSchemaCache();
  resetSettingsWindow();
  settingsFiles.clear();
  vi.restoreAllMocks();
});

async function show(opts: MockOptions = {}) {
  mockTauri(defaultHandlers(opts));
  const r = render(
    <>
      <SettingsView />
      <DialogHost />
    </>,
  );
  // The schema and the settings have arrived when General's first row shows its caption.
  await screen.findByText("Qnet asks on the next launch whether to reopen the tabs that were open at quit.");
  await waitFor(() => expect(getSetting("sim.replications", null)).not.toBeNull());
  return r;
}

const sidebar = () => screen.getByRole("navigation", { name: "Settings" });
const paneButtons = () => within(sidebar()).getAllByRole("listitem");
const heading = () => screen.getByRole("heading", { level: 2 }).textContent;

describe("the Settings window's panes", () => {
  it("lists the 13 panes in 0.90.34's order and groups, with their tooltips", async () => {
    await show();
    expect(paneButtons().map((b) => b.textContent)).toEqual([
      "General", "Solver Engine", "Discrete-Event Simulation", "SRBM MLMC", "Linear Program", "Finite-Buffer LP",
      "Finite Element", "Spectral Method", "Test Sets", "Output Format", "Panes", "Help", "AI Assistant",
    ]);
    expect(within(sidebar()).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["General", "Solvers", "Sweeps", "Interface", "Assistant"]);
    expect(paneButtons()[2]).toHaveAttribute("title", "jackson_sim / fBNAsim run length, parallelism and blocking");
    expect(heading()).toBe("General");
  });

  it("opens a pane, shows its rows with 0.90.34's words, and remembers it under its stored id", async () => {
    await show();
    fireEvent.click(within(sidebar()).getByText("Panes"));
    await waitFor(() => expect(heading()).toBe("Panes"));
    expect(getStateValue("settings.selectedPane", null)).toBe("Interactive Shell Window");
    expect(screen.getByText("Classic green-on-black")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Code font" })).toHaveDisplayValue("System Monospaced (default)");
    fireEvent.click(within(sidebar()).getByText("Discrete-Event Simulation"));
    await waitFor(() => expect(heading()).toBe("Discrete-Event Simulation"));
    expect(screen.getByRole("textbox", { name: "Replications" })).toHaveValue("50");
    expect(screen.getByRole("textbox", { name: "Warm-up period" })).toHaveValue("1,000,000");
    expect(screen.getByRole("combobox", { name: "Blocking mode" })).toHaveDisplayValue("BAS + external loss");
    expect(screen.getByText("The server blocks after service; external arrivals to a full buffer are lost — matches the RBM model.")).toBeInTheDocument();
  });

  it("falls back to General for a stored pane this build doesn't know (the removed GCDG pane)", async () => {
    await show({ state: { "settings.selectedPane": "GCDG" } });
    expect(heading()).toBe("General");
  });

  it("follows the menu: a menu row's caption describes the selection and the choice is stored", async () => {
    await show();
    const menu = screen.getByRole("combobox", { name: "On quit" });
    fireEvent.change(menu, { target: { value: "2" } });
    await waitFor(() => expect(getSetting("tabs.restoreBehavior", null)).toBe(2));
    expect(screen.getByText("Every launch starts with one empty tab.")).toBeInTheDocument();
  });
});

describe("Settings search", () => {
  it("filters the sidebar, counts matches per pane and steps through them with Return and Shift-Return", async () => {
    await show();
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(field, { target: { value: "seed" } });
    // General has no match, so the first pane with one opens and its row is already the named one.
    expect(paneButtons().map((b) => b.textContent)).toEqual(["Discrete-Event Simulation1", "SRBM MLMC2"]);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await waitFor(() => expect(heading()).toBe("Discrete-Event Simulation"));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await waitFor(() => expect(heading()).toBe("SRBM MLMC"));
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await waitFor(() => expect(heading()).toBe("Discrete-Event Simulation"));
    // Shift-Return from the first wraps round to the last.
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    // Every matching row keeps a tint while the query stands.
    await waitFor(() => expect(document.querySelector('[data-anchor="mlmc.seed"]')).toHaveClass("match"));
  });

  it("keeps the current pane when it has matches, so the first Return lands on the match it names", async () => {
    await show({ state: { "settings.selectedPane": "SRBM MLMC" } });
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(field, { target: { value: "seed" } });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(heading()).toBe("SRBM MLMC");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("matches every term, ignoring case and diacritics, against title, section, pane and keywords", () => {
    expect(matches("shell font").map((e) => e.id)).toEqual(["shell.fontName", "shell.fontSize"]);
    expect(matches("UTILIZATION").map((e) => e.id)).toEqual(["testset.inf.rho", "testset.fin.rho"]);
    expect(matches("Régénérative").map((e) => e.id)).toEqual(["engine.regenerative"]);
    expect(matches("   ")).toEqual([]);
  });

  it("says so when nothing matches, and Escape clears the query", async () => {
    await show();
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(field, { target: { value: "zzzz" } });
    expect(screen.getByText("No Results for “zzzz”")).toBeInTheDocument();
    expect(screen.getByText("Check the spelling or try a different search.")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("");
    expect(paneButtons()).toHaveLength(13);
  });

  it("is what Edit ▸ Search Settings… and Find Next / Previous drive while Settings has the keys", async () => {
    await show();
    const h = handlersFor("window:settings")!;
    expect(h.findTitle).toBe("Search Settings…");
    expect(h.canStepFind!()).toBe(false);
    act(() => h.find!());
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveFocus();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "seed" } });
    expect(h.canStepFind!()).toBe(true);
    act(() => h.stepFind!(1));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
  });
});

describe("Reset to Defaults", () => {
  it("is disabled while every key of the pane holds its default, and resets only that pane", async () => {
    await show({ settings: { "tabs.restoreBehavior": 1, "sim.replications": 80 } });
    const reset = () => screen.getByRole("button", { name: "Reset General settings to defaults" });
    expect(reset()).toBeEnabled();
    // The sidebar marks both panes that differ.
    expect(paneButtons()[0].querySelector(".set-dirty-dot")).toHaveAttribute("title", "General differs from its defaults");
    expect(paneButtons()[2].querySelector(".set-dirty-dot")).not.toBeNull();
    fireEvent.click(reset());
    await waitFor(() => expect(getSetting("tabs.restoreBehavior", null)).toBe(0));
    expect(await screen.findByText("Reset to defaults")).toBeInTheDocument();
    await waitFor(() => expect(reset()).toBeDisabled());
    expect(reset()).toHaveAttribute("title", "Already at defaults");
    expect(getSetting("sim.replications", null)).toBe(80);
    expect(paneButtons()[0].querySelector(".set-dirty-dot")).toBeNull();
  });

  it("counts on the AI pane only the current provider's endpoint, model and list and the generation keys", async () => {
    expect(resetKeys("AI Assistant", "ollama")).toEqual(["ai.baseURL.ollama", "ai.model.ollama", "ai.discovered.ollama", "ai.systemPrompt", "ai.maxTokens", "ai.temperature", "ai.timeoutSec"]);
    await show({ settings: { "ai.model.openai": "gpt-4.1", "ai.paneVisible": true }, state: { "settings.selectedPane": "AI Assistant" } });
    expect(screen.getByRole("button", { name: "Reset AI Assistant settings to defaults" })).toBeDisabled();
  });

  it("has the AI pane's live controls: Refresh model list, the API key field and Test Connection (SET-155, SET-160, SET-165)", async () => {
    await show({ settings: { "ai.provider": "anthropic" }, state: { "settings.selectedPane": "AI Assistant" } });
    await waitFor(() => expect(heading()).toBe("AI Assistant"));
    expect(screen.getByRole("button", { name: "Refresh model list" })).toBeEnabled();
    expect(screen.getByLabelText("API key")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("never touches pane visibility, the maximized pane or the provider (SET-034)", () => {
    const all = PANES.flatMap((p) => resetKeys(p.id, "anthropic"));
    for (const k of ["palette.paneVisible", "ai.paneVisible", "panes.soloed", "panes.detached", "results.autoShown", "ai.provider", "gcdg.enabled"]) expect(all).not.toContain(k);
  });
});

describe("number fields", () => {
  it("say what's wrong while typing and clamp into the range on Return", async () => {
    await show({ state: { "settings.selectedPane": "Simulation" } });
    const field = screen.getByRole("textbox", { name: "Replications" });
    fireEvent.change(field, { target: { value: "20000" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Must be between 1 and 10,000 runs");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(getSetting("sim.replications", null)).toBe(10000));
    expect(field).toHaveValue("10,000");
    fireEvent.change(field, { target: { value: "1.5" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number");
  });

  it("show Rust's sentence when it refuses a value", async () => {
    await show({ state: { "settings.selectedPane": "Simulation" } });
    extendMock({
      settings_patch: () => {
        throw { kind: "invalid", message: "The setting “sim.replications” takes a value from 1 to 10,000." };
      },
    });
    const field = screen.getByRole("textbox", { name: "Replications" });
    fireEvent.change(field, { target: { value: "60" } });
    fireEvent.blur(field);
    expect(await screen.findByRole("alert")).toHaveTextContent("The setting “sim.replications” takes a value from 1 to 10,000.");
  });

  it("step by their stepper, and an empty auto field stores 0", async () => {
    await show({ settings: { "lp.gridN": 30 }, state: { "settings.selectedPane": "Linear Program" } });
    fireEvent.click(screen.getByRole("button", { name: "Increase Grid size (grid_n)" }));
    await waitFor(() => expect(getSetting("lp.gridN", null)).toBe(31));
    const field = screen.getByRole("textbox", { name: "Grid size (grid_n)" });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    await waitFor(() => expect(getSetting("lp.gridN", null)).toBe(0));
    // The blank Untitled tab has no stations, so the recommendation is for d = 3.
    expect(field).toHaveAttribute("placeholder", "25");
    expect(screen.getByText("No network open — showing d = 3.")).toBeInTheDocument();
    expect(screen.getByLabelText("Recommended grid_n 25, basis_m 5")).toHaveTextContent("grid_n 25 · basis_m 5", { normalizeWhitespace: true });
    expect(screen.getByRole("switch", { name: "Auto-scale grid_n by dimension" })).toBeChecked();
  });
});

describe("the panes' own rules", () => {
  it("check a range's order, open a glossary entry, and count the spectral sweep", async () => {
    await show({ settings: { "testset.inf.stationsLo": 9 }, state: { "settings.selectedPane": "Test Sets" } });
    const stations = document.querySelector('[data-anchor="testset.inf.stations"]') as HTMLElement;
    expect(within(stations).getByRole("alert")).toHaveTextContent("Minimum must not exceed maximum");
    expect(screen.getByText(/10 cases × 10 ρ values = 100 spectral solves\./)).toBeInTheDocument();
    fireEvent.click(within(document.querySelector('[data-anchor="testset.inf.topology"]') as HTMLElement).getByRole("button", { name: "About Topology" }));
    expect(screen.getByRole("note")).toHaveTextContent("Feed-forward networks route every job strictly downstream.");
  });

  it("General's Change… opens the Discrete-Event Simulation pane", async () => {
    await show();
    expect(screen.getByText("BAS + external loss")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change blocking mode in Discrete-Event Simulation" }));
    await waitFor(() => expect(heading()).toBe("Discrete-Event Simulation"));
  });

  it("warns about a fine ε and a degree the monomial basis can't carry", async () => {
    await show({ settings: { "mlmc.epsilon": 0.0005, "sm.degree": 12 }, state: { "settings.selectedPane": "SRBM MLMC" } });
    expect(screen.getByText("ε = 0.0005 costs about 400× the default (ε = 0.01) — cost scales as 1/ε².")).toBeInTheDocument();
    fireEvent.click(within(sidebar()).getByText("Spectral Method"));
    expect(await screen.findByText("Monomial basis is ill-conditioned above degree 10 — enable Legendre.")).toBeInTheDocument();
  });
});

describe("Export… and Import…", () => {
  it("exports every setting and says where", async () => {
    await show();
    extendMock({ "plugin:dialog|save": () => "/Users/me/Qnet settings 2026-11-11.json" });
    fireEvent.click(screen.getByRole("button", { name: "Export settings to a file" }));
    expect(await screen.findByText(`Exported 111 settings to Qnet settings 2026-11-11.json (tagged Qnet ${mockInfo.version} (preview)).`)).toBeInTheDocument();
    const call = mockCalls.find((c) => c.cmd === "plugin:dialog|save")!;
    expect((call.args.options as { title: string }).title).toBe("Export Settings");
    expect(settingsFiles.get("/Users/me/Qnet settings 2026-11-11.json")).toContain('"sim.replications" : 50');
  });

  it("imports a file, changing what differs and naming what it refused by pane and row", async () => {
    await show();
    settingsFiles.set("/x/tuned.json", JSON.stringify({ "qnet.settingsFormat": 1, "sim.seed": 7, "fem.meshSize": 10, "mlmc.T": -1, "sm.legendre": "yes" }));
    extendMock({ "plugin:dialog|open": () => "/x/tuned.json" });
    fireEvent.click(screen.getByRole("button", { name: "Import settings from a file" }));
    expect(
      await screen.findByText(
        "Imported tuned.json: 1 setting changed, 1 already matched; 2 refused and left unchanged: SRBM MLMC ▸ Path length T (outside 0.01…10,000); Spectral Method ▸ Use Legendre basis (expected true or false).",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(getSetting("sim.seed", null)).toBe(7));
  });

  it("lists more than four refusals behind Show Details…", async () => {
    await show();
    settingsFiles.set("/x/bad.json", JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }));
    extendMock({ "plugin:dialog|open": () => "/x/bad.json" });
    fireEvent.click(screen.getByRole("button", { name: "Import settings from a file" }));
    expect(await screen.findByText("Imported bad.json: 0 settings changed; 5 refused and left unchanged.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show every refused import value" }));
    const list = screen.getByRole("region", { name: "Refused values" });
    expect(within(list).getByText("5 left unchanged")).toBeInTheDocument();
    expect(within(list).getByText("e — not a Qnet setting")).toBeInTheDocument();
  });

  it("refuses a file that is not a settings export, whole", async () => {
    await show();
    settingsFiles.set("/x/list.json", "[1, 2]");
    extendMock({ "plugin:dialog|open": () => "/x/list.json" });
    fireEvent.click(screen.getByRole("button", { name: "Import settings from a file" }));
    expect(await screen.findByText("Could not import: The file is not a Qnet settings export (expected a JSON object of setting keys).")).toBeInTheDocument();
  });
});

describe("Reset All Settings…", () => {
  it("asks first, then puts every pane back but leaves window layout alone", async () => {
    await show({ settings: { "sim.replications": 80, "output.decimals": 3, "palette.paneVisible": false } });
    expect(screen.getByText("2 of 13 panes differ from their defaults (marked in the sidebar).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset all settings to defaults" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Reset all settings to their defaults?");
    expect(dialog).toHaveTextContent("2 panes differ from the defaults and will be changed.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset All Settings" }));
    expect(await screen.findByText("Every pane is back at its defaults.")).toBeInTheDocument();
    await waitFor(() => expect(getSetting("sim.replications", null)).not.toBeNull());
    expect(getSetting("output.decimals", null)).toBe(6);
    expect(getSetting("palette.paneVisible", null)).toBe(false);
    expect(screen.getByText("Every pane is at its defaults.")).toBeInTheDocument();
  });
});

describe("Save and Cancel", () => {
  it("Return confirms with Saved (KEY-032) and Cancel closes", async () => {
    const onClose = vi.fn();
    mockTauri(defaultHandlers());
    render(<SettingsView onClose={onClose} />);
    await screen.findByText("Qnet asks on the next launch whether to reopen the tabs that were open at quit.");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "On quit" }).closest(".settings")!, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the registry", () => {
  it("titles every row with its label and names a key by pane and row", () => {
    for (const e of ENTRIES) expect(rows[e.id], e.id).toBeDefined();
    expect(displayName("mlmc.overrideT")).toBe("SRBM MLMC ▸ Path length T");
    expect(displayName("lp.gridN")).toBe("Linear Program ▸ Grid size (grid_n)");
    expect(displayName("ai.baseURL.ollama")).toBe("AI Assistant ▸ Base URL");
    expect(displayName("gcdg.enabled")).toBe("gcdg.enabled");
  });

  it("covers every stored key with a row or a reason", () => {
    const edited = new Set(PANES.flatMap((p) => keysFor(p.id)));
    for (const k of Object.keys(SETTINGS_DEFAULTS)) expect(edited.has(k) || k in UNINDEXED_KEYS, k).toBe(true);
  });
});

describe("Qnet ▸ Settings…", () => {
  it("opens the window, and opens it on the pane another window asks for", async () => {
    mockTauri(defaultHandlers());
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    vi.spyOn(window, "open").mockImplementation(() => win);
    function Host() {
      useSettingsCommands();
      return <SettingsHost />;
    }
    render(<Host />);
    await act(() => runCommand("app:settings"));
    const body = within(win.document.body);
    expect(await body.findByText("Discrete-Event Simulation")).toBeInTheDocument();
    expect(win.document.title).toBe("Settings");
    act(() => openSettings("Help menu"));
    await waitFor(() => expect(body.getByRole("heading", { level: 2 })).toHaveTextContent("Help"));
    expect(body.getByRole("combobox", { name: "Send help output to" })).toHaveDisplayValue("Qnet Help window");
    frame.remove();
  });
});
