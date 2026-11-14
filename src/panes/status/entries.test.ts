// A Status entry's severity, time, copy line and saved form (ledger LOG-002, LOG-004, LOG-021, FILE-047).
import { describe, expect, it } from "vitest";
import { decodeStatusEntry, formattedLine, formattedLines, inferSeverity, statusLogFileText, timeString } from "./entries";

describe("inferSeverity (0.90.34 StatusEntry.inferSeverity)", () => {
  it.each([
    ["⚠ Something odd", "warning"],
    ["⚠ Run failed", "error"],
    ["⚠ aborted by user", "error"],
    ["No warnings — banner hidden.", "success"],
    ["Run finished with 0 errors", "success"],
    ["Run finished without error", "success"],
    ["Error: no such file", "error"],
    ["The solver failed with code 2", "error"],
    ["Failed to start", "error"],
    ["File not found", "error"],
    ["Cannot open the network", "error"],
    ["Qnet could not write it", "error"],
    ["An invalid value", "error"],
    ["Network primitives aborted: no sink", "error"],
    ["Banner triggered by 2 warning(s):", "warning"],
    ["Run cancelled.", "warning"],
    ["The network is unstable", "warning"],
    ["Nothing to save — the status log is empty.", "warning"],
    ["No node matches “x”", "warning"],
    ["Skipping S3", "warning"],
    ["Saved 3 status entries to ~/x.txt.", "success"],
    ["  copied 2 lines", "success"],
    ["Found 4 nodes", "success"],
    ["Silent analysis ρ:  S1=0.7000  S2=0.7000", "info"],
    ["Ready. Choose a tool in the Tools pane to start building the network.", "info"],
    ["Analytical match is ASYMPTOTIC (x). At finite ρ, the asymptotic means may differ", "info"],
  ])("%s → %s", (text, sev) => {
    expect(inferSeverity(text)).toBe(sev);
  });

  it("checks negations before the error and warning words", () => {
    expect(inferSeverity("No errors, but invalid input was ignored")).toBe("success");
  });
});

describe("the copy and save line (formattedLine)", () => {
  const date = new Date(2026, 10, 11, 13, 2, 3).getTime();
  it("is [time] text for info and [time] [SEVERITY] text otherwise, in the locale's medium time", () => {
    const t = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(date));
    expect(timeString(date)).toBe(t);
    expect(formattedLine({ id: "a", date, severity: "info", text: "Ready." })).toBe(`[${t}] Ready.`);
    expect(formattedLine({ id: "b", date, severity: "warning", text: "Careful" })).toBe(`[${t}] [WARNING] Careful`);
    expect(formattedLine({ id: "c", date, severity: "success", text: "Saved" })).toBe(`[${t}] [SUCCESS] Saved`);
    expect(formattedLine({ id: "d", date, severity: "error", text: "Oops" })).toBe(`[${t}] [ERROR] Oops`);
  });

  it("joins lines with LF; the file adds a final newline", () => {
    const es = [
      { id: "a", date, severity: "info" as const, text: "one" },
      { id: "b", date, severity: "error" as const, text: "two" },
    ];
    expect(formattedLines(es).split("\n")).toHaveLength(2);
    expect(statusLogFileText(es)).toBe(formattedLines(es) + "\n");
  });
});

describe("decodeStatusEntry (LOG-002)", () => {
  const now = new Date(2026, 10, 11, 9, 0, 0).getTime();
  it("fills missing fields with a new id, now, info and an empty text", () => {
    const e = decodeStatusEntry({}, now);
    expect(e).toMatchObject({ date: now, severity: "info", text: "" });
    expect(e.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(decodeStatusEntry({ id: "X", date: 5, severity: "error", text: "t" }, now)).toEqual({ id: "X", date: 5, severity: "error", text: "t" });
  });

  it("migrates an old “[hh:mm:ss] text” string to today at that time, with an inferred severity", () => {
    const e = decodeStatusEntry("[1:02:03 PM] Saved network.bnet", now);
    const d = new Date(e.date);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 10, 11, 13, 2, 3]);
    expect(e).toMatchObject({ text: "Saved network.bnet", severity: "success" });
    expect(new Date(decodeStatusEntry("[13:02:03] x", now).date).getHours()).toBe(13);
  });

  it("keeps a string without a time verbatim, stamped now", () => {
    expect(decodeStatusEntry("[later] Run failed", now)).toMatchObject({ text: "[later] Run failed", date: now, severity: "error" });
  });
});
