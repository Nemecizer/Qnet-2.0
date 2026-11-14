// The main window against the simulated backend: the frame P4 builds on.
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { defaultHandlers } from "../dev/mockBackend";
import { mockInfo } from "../dev/mock/core";
import { lastMenu } from "../dev/mock/menu";
import { api, CommandError } from "../lib/api";
import type { MenuNode } from "../lib/menu";
import { mockTauri } from "./tauri";

describe("the main window", () => {
  it("opens on one Untitled tab and names the build in the status bar", async () => {
    mockTauri(defaultHandlers());
    render(<App />);
    expect(screen.getAllByText("Untitled").length).toBeGreaterThan(0);
    expect(screen.getByText("No Network Yet")).toBeInTheDocument();
    expect(await screen.findByText(`Qnet ${mockInfo.version} (dev, preview)`)).toBeInTheDocument();
  });

  it("says which file it set aside when one couldn't be read", async () => {
    mockTauri(defaultHandlers({ setAside: [{ file: "settings.json", path: "/c/settings.json", backup: "/c/settings.json.corrupt-1", error: "EOF", tsMs: 1 }] }));
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent("Qnet couldn't read settings.json, so it started from defaults. The original is kept at /c/settings.json.corrupt-1.");
  });

  it("installs the menu bar, with the palette's own command enabled and a later phase's dimmed", async () => {
    mockTauri(defaultHandlers());
    lastMenu.nodes = null;
    render(<App />);
    const items = () => {
      const flat: { id: string; enabled: boolean; label: string }[] = [];
      const walk = (n: MenuNode[]): void => n.forEach((x) => (x.type === "item" ? void flat.push(x) : x.type === "submenu" ? walk(x.items) : undefined));
      walk((lastMenu.nodes as unknown as MenuNode[] | null) ?? []);
      return flat;
    };
    // The first menu goes out at once; the commands registered as the app mounts follow a frame later.
    await waitFor(() => expect(items().find((i) => i.id === "view:command-palette")?.enabled).toBe(true));
    const flat = items();
    expect(flat.find((i) => i.id === "run:qna")).toMatchObject({ label: "Run Whitt QNA", enabled: false });
    expect((lastMenu.nodes as unknown as MenuNode[]).map((n) => (n.type === "submenu" ? n.label : n.type))).toEqual(["Qnet", "File", "Edit", "View", "Network", "Tools", "Run", "Test", "Window", "Help"]);
  });

  it("mounts the Fit from Data host, so the panel opens in the app's own tree and not in a root of its own", async () => {
    mockTauri(defaultHandlers());
    const { fitHosts } = await import("../fit/store");
    const before = fitHosts.mounted;
    const view = render(<App />);
    await waitFor(() => expect(fitHosts.mounted).toBe(before + 1));
    view.unmount();
    expect(fitHosts.mounted).toBe(before);
  });

  it("opens the command palette from its command and closes it with Escape", async () => {
    mockTauri(defaultHandlers());
    render(<App />);
    const { runCommand } = await import("../lib/commands");
    await act(() => runCommand("view:command-palette"));
    const field = await screen.findByRole("combobox", { name: "Search commands" });
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });
});

describe("the command wrapper", () => {
  it("turns a command's refusal into a CommandError with its kind and sentence", async () => {
    mockTauri(defaultHandlers());
    const err = await api.settingsPatch({ "status.paneVisibl": false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).kind).toBe("invalid");
    expect(String(err)).toBe("There's no setting called “status.paneVisibl”.");
    expect((await api.settingsPatch({ "status.paneVisible": false }))["status.paneVisible"]).toBe(false);
    expect((await api.settingsGet())["status.paneVisible"]).toBe(false);
  });

  it("reads a refusal sent as JSON text the same way", async () => {
    mockTauri({ settings_get: () => Promise.reject(JSON.stringify({ message: "Couldn't read settings.json.", kind: "failed", detail: "EACCES" })) });
    const err = (await api.settingsGet().catch((e: unknown) => e)) as CommandError;
    expect(err).toBeInstanceOf(CommandError);
    expect([err.kind, err.message, err.detail]).toEqual(["failed", "Couldn't read settings.json.", "EACCES"]);
  });
});
