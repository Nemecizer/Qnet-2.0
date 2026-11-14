// The command palette and the commands that wait while a dialog is up (`modalOpen()` in their
// `when`): the palette is the thing asking, so it does not count against the command it is about
// to run — but a real dialog under it still does. Found with Run ▸ Sensitivity…, which ⌘K listed
// dimmed ("Close the open dialog first") and would not run.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { defaultHandlers } from "../dev/mockBackend";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { closePalette, holdModal, MODAL_REASON, modalOpen, openPalette, resetOverlays } from "../lib/overlays";
import { SENSITIVITY_COMMAND, startSensitivityCommands } from "../sensitivity/commands";
import { resetSensitivityStore, takeSensitivityViewRequest } from "../sensitivity/store";
import { sensitivityWords } from "../sensitivity/words";
import { mockTauri } from "../test/tauri";
import { addTab, resetWorkspace } from "../workspace/store";
import { CommandPalette } from "./CommandPalette";

const examples = import.meta.glob("../../examples/OpenJackson.d2.feedback.p30.inf.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const WAIT = { timeout: 8000 };

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetOverlays();
  resetSensitivityStore();
  startSensitivityCommands();
  addTab({ title: "feedback.bnet", path: null, document: { canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(Object.values(examples)[0]) } as BnetDocument });
});
afterEach(() => resetOverlays());

const row = () => screen.getByRole("option", { name: new RegExp(`^${sensitivityWords.menuTitle.replace("…", "")}`) });

describe("the command palette", () => {
  it("lists Sensitivity… as available and runs it: the Results pane is asked for its Sensitivity view", async () => {
    render(<CommandPalette />);
    act(() => openPalette());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sensitivity" } });
    expect(row()).not.toHaveAttribute("aria-disabled");
    expect(row()).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(takeSensitivityViewRequest()).toBe(true), WAIT);
  });

  it("still counts as modal to everything else, and a dialog under it still dims the command", () => {
    render(<CommandPalette />);
    act(() => openPalette());
    // Outside the palette's own question the palette is a modal: a shortcut pressed now waits.
    expect(modalOpen()).toBe(true);
    expect(unavailableReason(getCommand(SENSITIVITY_COMMAND)!)).toBe(MODAL_REASON);
    act(() => closePalette());
    let release = () => {};
    act(() => void (release = holdModal()));
    act(() => openPalette());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sensitivity" } });
    expect(row()).toHaveAttribute("aria-disabled", "true");
    expect(row()).toHaveTextContent(MODAL_REASON);
    act(() => release());
  });
});
