// The update sheet, the menu item and Settings ▸ General ▸ Updates against the preview backend
// (ledger UX-501…): an unconfigured copy says it does not check and asks nothing of the server;
// a configured one offers the version with its notes shown as text, never as HTML.
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../dev/mockBackend";
import { mockInfo } from "../dev/mock/core";
import { MOCK_NOTES, mockUpdates } from "../dev/mock/updates";
import { runCommand } from "../lib/commands";
import { getStateValue, loadKv } from "../lib/kv";
import { MENU_SPEC, type SpecEntry } from "../lib/menuSpec";
import { modalOpen } from "../lib/overlays";
import { mockCalls, mockTauri } from "../test/tauri";
import { SettingsView } from "../windows/settings/SettingsView";
import { resetUpdates, SKIPPED_KEY, UpdateHost, useUpdateCommands } from ".";
import { noteBlocks } from "./notes";
import { updateWords } from "./words";

function Harness() {
  useUpdateCommands();
  return (
    <div className="app">
      <UpdateHost />
    </div>
  );
}

afterEach(() => resetUpdates());

function mount(configure: () => void = () => {}) {
  mockTauri(defaultHandlers());
  configure();
  resetUpdates();
  return render(<Harness />);
}

const called = (cmd: string) => mockCalls.filter((c) => c.cmd === cmd).length;
const AVAILABLE = { version: "2.2.0", notes: MOCK_NOTES, date: "2027-01-05" };

describe("a copy of Qnet built without an update address", () => {
  it("says it does not check for updates, calmly, and contacts nothing", async () => {
    mount();
    await waitFor(() => expect(called("update_status")).toBeGreaterThan(0));
    await act(async () => void (await runCommand("app:check-updates")));
    const sheet = await screen.findByRole("dialog", { name: "This copy of Qnet does not check for updates." });
    expect(sheet).toHaveAccessibleDescription(updateWords.disabledBody);
    expect(modalOpen()).toBe(true);
    expect(called("update_check")).toBe(0);
    expect(called("update_install")).toBe(0);
    const ok = within(sheet).getByRole("button", { name: "OK" });
    expect(ok).toHaveFocus();
    fireEvent.click(ok);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(modalOpen()).toBe(false);
  });

  it("explains the same in Settings, with the switch dimmed", async () => {
    mockTauri(defaultHandlers());
    render(<SettingsView />);
    const section = await screen.findByRole("region", { name: "Updates" });
    expect(await within(section).findByText(updateWords.settings.footerOff)).toBeInTheDocument();
    expect(within(section).getByRole("switch", { name: "Check for updates automatically" })).toBeDisabled();
    expect(within(section).queryByRole("button", { name: "Check for Updates…" })).toBeNull();
    expect(called("update_check")).toBe(0);
  });
});

describe("a copy configured to update", () => {
  it("offers a new version at launch, with its notes as text and never as HTML", async () => {
    mount(() => Object.assign(mockUpdates, { configured: true, available: AVAILABLE }));
    const sheet = await screen.findByRole("dialog", { name: "Qnet 2.2.0 is available." });
    expect(sheet).toHaveAccessibleDescription(`You have version ${mockInfo.version}. The new version was published on 2027-01-05.`);
    const notes = within(sheet).getByRole("region", { name: "What’s new" });
    expect(within(notes).getByRole("heading", { name: "Qnet 2.2" })).toBeInTheDocument();
    expect(within(notes).getAllByRole("listitem")).toHaveLength(3);
    expect(within(notes).getByText("Faster charts for networks with many classes.")).toBeInTheDocument();
    // The tag in the notes is characters on the page, not an element.
    expect(notes.querySelector("img, script, a, iframe")).toBeNull();
    expect(within(notes).getByText("<img src=x onerror=alert(1)> is shown as text, never run.")).toBeInTheDocument();
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(["Skip This Version", "Later", "Install and Relaunch"]);
    expect(within(sheet).getByRole("button", { name: "Install and Relaunch" })).toHaveFocus();
    // Escape is Later.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("remembers Skip This Version", async () => {
    mount(() => Object.assign(mockUpdates, { configured: true, available: AVAILABLE }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip This Version" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await loadKv();
    await waitFor(() => expect(getStateValue(SKIPPED_KEY, null)).toBe("2.2.0"));
  });

  it("says Qnet is up to date when asked and there is nothing newer", async () => {
    mount(() => Object.assign(mockUpdates, { configured: true }));
    await waitFor(() => expect(called("update_check")).toBe(1));
    await act(async () => void (await runCommand("app:check-updates")));
    const sheet = await screen.findByRole("dialog", { name: "Qnet is up to date." });
    expect(sheet).toHaveAccessibleDescription(`Version ${mockInfo.version} is the newest version.`);
  });

  it("shows the download's progress, and a bad signature in plain words with nothing installed", async () => {
    mount(() => Object.assign(mockUpdates, { configured: true, available: AVAILABLE, fail: "badsig", stepMs: 1 }));
    fireEvent.click(await screen.findByRole("button", { name: "Install and Relaunch" }));
    const bar = await screen.findByRole("progressbar", { name: "Download progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuetext", expect.stringMatching(/ of 84\.0 MB$/)));
    const sheet = await screen.findByRole("dialog", { name: "Qnet couldn’t update." });
    expect(sheet).toHaveAccessibleDescription(/isn't signed by Qnet's author, so it was not installed\. This copy of Qnet is unchanged\./);
    expect(within(sheet).getByText("Signature verification failed")).toBeInTheDocument();
    expect(mockUpdates.relaunchArmed).toBe(false);
    expect(called("update_relaunch")).toBe(0);
  });

  it("says in plain words when the server can't be reached", async () => {
    mount(() => Object.assign(mockUpdates, { configured: true, fail: "offline" }));
    // The launch check failed silently.
    await waitFor(() => expect(called("update_check")).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => void (await runCommand("app:check-updates")));
    const sheet = await screen.findByRole("dialog", { name: "Qnet couldn’t update." });
    expect(sheet).toHaveAccessibleDescription(/couldn't reach the update server/);
  });
});

describe("the sheet and the keyboard", () => {
  it("gives the focus back to what had it before the sheet opened (review)", async () => {
    mockTauri(defaultHandlers());
    Object.assign(mockUpdates, { configured: true });
    resetUpdates();
    function WithButton() {
      useUpdateCommands();
      return (
        <div className="app">
          <button>Canvas tool</button>
          <UpdateHost />
        </div>
      );
    }
    render(<WithButton />);
    await waitFor(() => expect(called("update_check")).toBe(1));
    const before = screen.getByRole("button", { name: "Canvas tool" });
    before.focus();
    await act(async () => void (await runCommand("app:check-updates")));
    const sheet = await screen.findByRole("dialog", { name: "Qnet is up to date." });
    expect(before).not.toHaveFocus();
    fireEvent.click(within(sheet).getByRole("button"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(before).toHaveFocus();
  });
});

describe("release notes", () => {
  it("are read into headings, lists and paragraphs, with marks dropped and tags left as text", () => {
    expect(noteBlocks("# New\r\n\r\nFirst line\nsecond line\n\n* one\n- **two**\n\n<script>alert(1)</script> `code`")).toEqual([
      { kind: "heading", text: "New" },
      { kind: "paragraph", text: "First line second line" },
      { kind: "list", items: ["one", "two"] },
      { kind: "paragraph", text: "<script>alert(1)</script> code" },
    ]);
    expect(noteBlocks("  \n")).toEqual([]);
  });
});

describe("the menu", () => {
  it("has Check for Updates… under About Qnet, in the app menu", () => {
    const app = MENU_SPEC[0] as Extract<SpecEntry, { submenu: string }>;
    const ids = app.items.map((i) => (typeof i === "object" && "id" in i ? i.id : null));
    expect(ids.indexOf("app:check-updates")).toBe(ids.indexOf("app:about") + 1);
    const item = app.items[ids.indexOf("app:check-updates")] as { label: string };
    expect(item.label).toBe("Check for Updates…");
  });
});
