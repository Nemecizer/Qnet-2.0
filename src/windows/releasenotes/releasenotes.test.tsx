// Help ▸ Release Notes against the preview backend: 0.90.34's notes carried over, 2.0's frozen
// entry, the running build's entry, the bar (count, Expand All, Copy), the running build's entry and the closed earlier releases
// (ledger ABOUT-011…018, SET-203).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockInfo } from "../../dev/mock/core";
import { mockTauri } from "../../test/tauri";
import { CHANGELOG, entryPlainText, LAST_0_90, openReleaseNotes, releaseNotesOpen, ReleaseNotesHost, ReleaseNotesView, resetReleaseNotesWindow, shownDate, shownVersion, topEntryIsLive, type ChangelogEntry } from ".";

afterEach(() => {
  resetReleaseNotesWindow();
  vi.restoreAllMocks();
});

async function show(entries?: ChangelogEntry[]) {
  mockTauri(defaultHandlers());
  const r = render(<ReleaseNotesView entries={entries} />);
  await screen.findByText(`Qnet ${mockInfo.version}`);
  await screen.findByLabelText(/^(In development|Current release)$/);
  await waitFor(() => expect(document.querySelector(".rn-entry.current .rn-date, .rn-warning")).not.toBeNull());
  return r;
}

/** The running build as the preview backend reports it: the version every place agrees on. */
const V = mockInfo.version;
/** How many notes the running build's entry has. */
const LIVE = CHANGELOG[0].notes.length;
/** A shipped release by its version, wherever it now sits in the list. */
const release = (v: string) => CHANGELOG.find((e) => e.version === v)!;
/** How many notes every shipped release below the running one carries, together. */
const SHIPPED = CHANGELOG.slice(1).reduce((n, e) => n + e.notes.length, 0);

describe("the changelog", () => {
  it("is the running build's entry, 2.0's frozen, then 0.90.34's two, carried over word for word (ABOUT-017)", () => {
    // Each 2.1 release keeps its build stamp, newest first; then 2.0 and 0.90.34's two, unchanged.
    expect(CHANGELOG.slice(1, 3).map((e) => [e.version, e.timestamp])).toEqual([["2.1.1", "11.13.2026.1543"], ["2.1.0", "11.13.2026.1336"]]);
    expect(CHANGELOG.slice(-3).map((e) => [e.version, e.timestamp, e.notes.length])).toEqual([["2.0.0", "11.12.2026.1022", 1], ["0.90.34", "09.04.2026.1534", 204], ["0.90.01", "04.26.2026.1647", 9]]);
    expect(LAST_0_90).toEqual({ version: "0.90.34", timestamp: "09.04.2026.1534" });
    expect(topEntryIsLive()).toBe(true);
    // 0.90.34's words, from Changelog.swift with its string escapes resolved ("\\u{25B8}" is ▸).
    expect(release("0.90.34").notes[0]).toMatch(/^Network ▸ Analyze Network and the canvas warning now check the SRBM the app actually exports/);
    expect(release("0.90.34").notes[15]).toMatch(/^Stop now stops the solver\. Run ▸ Stop Run signalled only the wrapper shell/);
    expect(release("0.90.34").notes.at(-1)).toBe("Added the Qnet --export-cmp <bnet> <outdir> CLI mode that writes every solver's input file so the solvers can be invoked directly.");
    expect(release("0.90.01").notes[0]).toMatch(/^Renamed the application from BNET to Qnet \(visible name and bundle\)\./);
    expect(release("0.90.01").notes.at(-1)).toBe("GUI: the application Help menu now leads with this Changelog item, and the macOS About menu now opens a custom \"About Qnet\" window showing the full version identifier.");
    for (const e of CHANGELOG) for (const note of e.notes) expect(note).not.toMatch(/\\u\{|\\"/);
    // Plain prose: no markup is read, and none is written (ABOUT-018).
    for (const e of CHANGELOG) for (const note of e.notes) expect(note).not.toMatch(/^\s*[-*#]\s|\n/);
  });

  it("has the running build's entry on top, live, each note plain prose (ABOUT-013, ABOUT-018)", () => {
    const [live, ...shipped] = CHANGELOG;
    expect(live.version).toBe(V);
    expect(live.timestamp).toBeNull();
    // Exactly one live entry: every release below it is frozen with its MM.DD.YYYY.HHMM stamp.
    for (const e of shipped) expect(e.timestamp, e.version).toMatch(/^\d{2}\.\d{2}\.\d{4}\.\d{4}$/);
    expect(live.notes.length).toBeGreaterThan(0);
    expect(new Set(live.notes).size).toBe(live.notes.length);
    expect(live.notes[0].startsWith(`Qnet ${V.split(".").slice(0, 2).join(".")}`)).toBe(true);
    for (const note of live.notes) {
      // One paragraph of sentences: no line breaks, list or heading markers, Markdown emphasis,
      // code, links or HTML, and no stray space at either end.
      expect(note, note).toMatch(/^[A-Z].*[.!?]$/);
      expect(note, note).not.toMatch(/\n|^\s|\s$|\s{2}/);
      expect(note, note).not.toMatch(/^\s*([-*#>•]|\d+[.)])\s/);
      expect(note, note).not.toMatch(/[*_`]|\[[^\]]*\]\(|<\/?[a-z][^>]*>|https?:\/\//i);
    }
  });

  it("says in one paragraph what 2.0 was: a rebuild with the same functions", () => {
    expect(release("2.0.0").notes).toHaveLength(1);
    const [note] = release("2.0.0").notes;
    expect(note).toMatch(/^Qnet 2\.0 is Qnet 0\.90\.34 rebuilt, with the same functions/);
    expect(note).toContain("The solvers are 0.90.34's own code, unchanged");
    expect(note).toContain("docs/PARITY.md");
  });
});

describe("the Release Notes window", () => {
  it("heads the page with the app's version and counts the releases in a fixed bar (ABOUT-012)", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Release Notes");
    expect(screen.getByText(`Qnet ${V}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`${CHANGELOG.length} releases listed`)).toHaveTextContent(`${CHANGELOG.length} releases`);
    expect(screen.getByRole("button", { name: "Expand all releases" })).toHaveTextContent("Expand All");
    expect(screen.getByRole("button", { name: "Copy current release notes" })).toHaveTextContent("Copy");
  });

  it("shows the running build's entry open with its badge, and every earlier release closed (ABOUT-013, ABOUT-014)", async () => {
    await show();
    const current = screen.getByRole("region", { name: `Version ${V}` });
    expect(within(current).getByRole("heading", { level: 2 })).toHaveTextContent(`Version ${V}`);
    expect(within(current).getByLabelText("In development")).toHaveTextContent("In development");
    const date = within(current).getByText("12 May 2026, 06:06");
    expect(date).toHaveAttribute("title", `Build ${V}.05.12.2026.0606`);
    expect(within(current).getAllByRole("listitem")).toHaveLength(LIVE);
    const older = screen.getAllByRole("button", { expanded: false });
    expect(older.slice(0, 2).map((b) => b.textContent)).toEqual(["Version 2.1.1—13 November 2026, 15:43", "Version 2.1.0—13 November 2026, 13:36"]);
    expect(older.slice(-3).map((b) => b.textContent)).toEqual(["Version 2.0.0—12 November 2026, 10:22", "Version 0.90.34—4 September 2026, 15:34", "Version 0.90.01—26 April 2026, 16:47"]);
    expect(older.at(-3)).toHaveAccessibleName("Version 2.0.0, 12 November 2026, 10:22");
    expect(older.at(-2)).toHaveAccessibleName("Version 0.90.34, 4 September 2026, 15:34");
    expect(screen.getAllByRole("listitem")).toHaveLength(LIVE);
    const first = older.at(-1)!;
    fireEvent.click(first);
    expect(screen.getAllByRole("listitem")).toHaveLength(LIVE + 9);
    expect(first).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(first);
    expect(screen.getAllByRole("listitem")).toHaveLength(LIVE);
  });

  it("expands and collapses every shipped release at once (ABOUT-012)", async () => {
    await show();
    const all = screen.getByRole("button", { name: "Expand all releases" });
    expect(all).toHaveAttribute("title", "Open every shipped release below the current one");
    fireEvent.click(all);
    expect(screen.getAllByRole("listitem")).toHaveLength(LIVE + SHIPPED);
    const collapse = screen.getByRole("button", { name: "Collapse all releases" });
    expect(collapse).toHaveTextContent("Collapse All");
    expect(collapse).toHaveAttribute("title", "Collapse every shipped release again");
    fireEvent.click(collapse);
    expect(screen.getAllByRole("listitem")).toHaveLength(LIVE);
  });

  it("copies the top entry only, as plain text, and says “Copied” for a moment (ABOUT-015)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await show();
    const button = screen.getByRole("button", { name: "Copy current release notes" });
    expect(button).toHaveAttribute("title", "Copy this release's notes as plain text — the entry at the top only, not the whole history");
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(`Qnet ${V} — 12 May 2026, 06:06 (build ${V}.05.12.2026.0606)\n\n${CHANGELOG[0].notes.map((n) => `• ${n}\n`).join("")}`);
      expect(screen.getByRole("button", { name: "Copied current release notes" })).toHaveTextContent("Copied");
      act(() => void vi.advanceTimersByTime(1499));
      expect(screen.getByRole("button", { name: "Copied current release notes" })).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(2));
      expect(screen.getByRole("button", { name: "Copy current release notes" })).toHaveTextContent("Copy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a frozen entry with its own version and stamp, and the live one with the build's (ABOUT-014, ABOUT-015)", () => {
    const app = { version: V, built: new Date(2026, 4, 12, 6, 6) };
    expect(entryPlainText(release("0.90.01"), app).split("\n").slice(0, 3)).toEqual(["Qnet 0.90.01 — 26 April 2026, 16:47 (build 0.90.01.04.26.2026.1647)", "", `• ${release("0.90.01").notes[0]}`]);
    expect(entryPlainText(release("2.0.0"), app)).toBe(`Qnet 2.0.0 — 12 November 2026, 10:22 (build 2.0.0.11.12.2026.1022)\n\n• ${release("2.0.0").notes[0]}\n`);
    const live: ChangelogEntry = { version: "0.0.0", timestamp: null, notes: ["a", "b"] };
    expect(shownVersion(live, app)).toBe(V);
    expect(shownDate(live, app)).toBe("12 May 2026, 06:06");
    expect(entryPlainText(live, app)).toBe(`Qnet ${V} — 12 May 2026, 06:06 (build ${V}.05.12.2026.0606)\n\n• a\n• b\n`);
    expect(entryPlainText(live, { version: V, built: null })).toBe(`Qnet ${V}\n\n• a\n• b\n`);
    expect(shownDate({ version: "1", timestamp: "not a stamp", notes: [] }, app)).toBe("not a stamp");
  });

  it("marks a frozen top entry “Current” and, in a development build, tells the maintainer (ABOUT-013, ABOUT-016)", async () => {
    await show(CHANGELOG.slice(CHANGELOG.indexOf(release("2.0.0"))));
    const current = screen.getByRole("region", { name: "Version 2.0.0" });
    expect(within(current).getByLabelText("Current release")).toHaveTextContent("Current");
    await screen.findByText((text) => text.includes(`${V}.05.12.2026.0606`));
    expect(screen.getByRole("note")).toHaveTextContent(`Debug build note: the newest entry below is frozen, so this build (${V}.05.12.2026.0606) has no in-development entry.`);
    expect(screen.getByLabelText("3 releases listed")).toBeInTheDocument();
  });

  it("has no maintainer note when the top entry is the running build's", async () => {
    await show();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("is one window, 816 × 640 and never smaller than 720 × 560, titled “Release Notes” (ABOUT-011)", async () => {
    mockTauri(defaultHandlers());
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    const opened = vi.spyOn(window, "open").mockImplementation(() => win);
    vi.spyOn(win, "focus").mockImplementation(() => {});
    render(<ReleaseNotesHost />);
    act(() => openReleaseNotes());
    expect(opened).toHaveBeenCalledWith(expect.stringMatching(/^about:blank#aux=release-notes&id=[a-z0-9]+&minw=720&minh=560$/), "qnet-release-notes", "width=816,height=640");
    expect(await within(win.document.body).findByText(`Qnet ${V}`)).toBeInTheDocument();
    expect(win.document.title).toBe("Release Notes");
    act(() => openReleaseNotes());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(releaseNotesOpen()).toBe(true);
    await waitFor(() => expect(win.document.body.querySelector(".rn")).not.toBeNull());
    frame.remove();
  });
});
