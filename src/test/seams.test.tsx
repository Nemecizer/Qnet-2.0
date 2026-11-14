// Where the P4 areas meet: the integration review's findings, kept fixed.
import { describe, expect, it } from "vitest";
import { defaultHandlers } from "../dev/mockBackend";
import { mockSession } from "../dev/mock/session";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv } from "../lib/kv";
import { holdModal } from "../lib/overlays";
import { fileCommands } from "../workspace/files";
import { replaceWorkspace } from "../workspace/store";
import { quit, restoreSession, snapshot } from "../workspace/tabs/session";
import { seed, tab } from "../workspace/tabs/testkit";
import { mockTauri } from "./tauri";

describe("a quit that arrives while the launch is still restoring", () => {
  it("waits for the restore, so the saved session isn't mistaken for nothing and cleared", async () => {
    // The session a previous launch saved: one tab with a network, behaviour Always restore.
    seed([tab("A", { title: "tandem.bnet", path: "/n/tandem.bnet", nodes: 3 })]);
    const saved = snapshot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers = defaultHandlers({ settings: { "tabs.restoreBehavior": 1 } });
    mockTauri({ ...handlers, session_get: async () => (await gate, saved) });
    mockSession.snapshot = saved;
    replaceWorkspace({ tabs: [tab("BLANK")], activeId: "BLANK" });
    const restoring = restoreSession();
    const quitting = quit();
    // The session file arrives only after the quit has had every chance to look at the workspace.
    setTimeout(release, 50);
    await Promise.all([restoring, quitting]);
    expect(mockSession.snapshot).not.toBeNull();
    expect(JSON.stringify(mockSession.snapshot)).toContain("tandem.bnet");
  });
});

describe("document commands while a dialog is up (MENU-198)", () => {
  it("wait: New, Open, Open Example, Save and Save As are refused with the dialog's reason", async () => {
    mockTauri(defaultHandlers());
    await loadKv();
    const ids = ["file:new", "file:open", "file:open-example", "file:save", "file:save-as"];
    const cmds = fileCommands().filter((c) => ids.includes(c.id));
    expect(cmds.map((c) => c.id).sort()).toEqual([...ids].sort());
    const release = holdModal();
    for (const c of cmds) expect(unavailableReason(c), c.id).toBe("Close the open dialog first");
    release();
    expect(unavailableReason(cmds.find((c) => c.id === "file:new")!)).toBeNull();
    expect(getCommand("file:new")).toBeUndefined();
  });
});

describe("closing an auxiliary window (owner's report, 2026-11-11)", () => {
  it("asks Rust to close exactly that native window: its own close only empties the web view", async () => {
    const { AuxWindow, auxWindow } = await import("../lib/auxWindow");
    const { mockCalls, mockTauri } = await import("./tauri");
    const { defaultHandlers } = await import("../dev/mockBackend");
    const { render, act } = await import("@testing-library/react");
    mockTauri(defaultHandlers());
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const { vi } = await import("vitest");
    const stub = vi.spyOn(window, "open").mockImplementation(() => frame.contentWindow!);
    const r = render(<AuxWindow name="probe" title="Probe" size={[300, 200]} onClose={() => {}}><span>in</span></AuxWindow>);
    const label = auxWindow("probe")!.label;
    expect(label).toMatch(/^aux-probe-[a-z0-9]+$/);
    await act(async () => r.unmount());
    expect(mockCalls.filter((c) => c.cmd === "aux_close").map((c) => c.args)).toEqual([{ label }]);
    stub.mockRestore();
  });
});
