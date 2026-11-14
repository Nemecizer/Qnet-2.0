// A Status line's action (actions.ts, new in 2.0): a button beside the text, which leaves the
// line's text, its copy and the log itself as they were.
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { loadKv } from "../../lib/kv";
import { mockTauri } from "../../test/tauri";
import { getWorkspace, replaceWorkspace, tabById, type StatusEntry } from "../../workspace/store";
import { resetStatusActions, setStatusAction, statusAction } from "./actions";
import { resetSilentAnalysis } from "./analysis";
import { formattedLines } from "./entries";
import { StatusPane } from "./index";
import { paneState, resetPaneStates } from "./state";

const T0 = new Date(2026, 10, 12, 9, 0, 0).getTime();
const log: StatusEntry[] = [
  { id: "E1", date: T0, severity: "info", text: "Running Linear Program (BNAlp)..." },
  { id: "E2", date: T0 + 12000, severity: "error", text: "Linear Program failed (exit 1) after 12 s" },
];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetPaneStates();
  resetSilentAnalysis();
  resetStatusActions();
  await loadKv();
  act(() => replaceWorkspace({ tabs: [{ id: "TAB-1", title: "t", path: null, document: { nodes: [], links: [], infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0] }, revision: 0, savedRevision: 0, log }], activeId: "TAB-1" }));
});

const rows = () => screen.getAllByRole("option");

describe("a Status line's action", () => {
  it("is a button on that line only, and running it changes neither the line nor the selection", async () => {
    render(<StatusPane />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Show Report…" })).toBeNull();

    let ran = 0;
    act(() => setStatusAction("E2", { label: "Show Report…", help: "Explain this failure and show what was run", run: () => void ran++ }));
    const button = within(rows()[1]).getByRole("button", { name: "Show Report…" });
    expect(button.title).toBe("Explain this failure and show what was run");
    expect(within(rows()[0]).queryByRole("button")).toBeNull();

    fireEvent.mouseUp(button);
    fireEvent.click(button);
    expect(ran).toBe(1);
    expect(paneState("TAB-1").selection.size).toBe(0);

    // 0.90.34's sentence is as it was: on screen, in the log and in what Copy puts on the clipboard.
    expect(rows()[1].querySelector(".status-row-text")!.textContent).toBe("Linear Program failed (exit 1) after 12 s");
    expect(tabById(getWorkspace().activeId)!.log).toEqual(log);
    expect(formattedLines([log[1]])).not.toContain("Show Report");

    act(() => setStatusAction("E2", null));
    expect(screen.queryByRole("button", { name: "Show Report…" })).toBeNull();
  });

  it("keeps at most 200 lines' actions, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) setStatusAction(`L${i}`, { label: "x", run: () => {} });
    expect(statusAction("L4")).toBeUndefined();
    expect(statusAction("L5")).toBeDefined();
    expect(statusAction("L204")).toBeDefined();
  });
});
