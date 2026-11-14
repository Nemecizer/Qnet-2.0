// Qnet ▸ About Qnet against the preview backend: 0.90.34's layout and words with 2.0's version,
// the Acknowledgements list, Release Notes, Close on Return, and the window itself (ledger
// ABOUT-001…007, ABOUT-010, MENU-001, KEY-031, SET-199).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockInfo } from "../../dev/mock/core";
import { mockHelp } from "../../dev/mock/help";
import { mockTauri } from "../../test/tauri";
import { releaseNotesOpen, resetReleaseNotesWindow } from "../releasenotes";
import { AboutHost, AboutView, ACKNOWLEDGEMENTS, aboutOpen, copyrightYear, dateText, humanReadable, openAbout, parseStamp, resetAboutWindow, stampHumanReadable, stampText, timeText } from ".";

afterEach(() => {
  resetAboutWindow();
  resetReleaseNotesWindow();
  vi.restoreAllMocks();
});

async function show(onClose = vi.fn()) {
  mockTauri(defaultHandlers());
  render(<AboutView onClose={onClose} />);
  await screen.findByText((text) => text.startsWith(`Version ${mockInfo.version}`));
  await screen.findByText(/^Built /);
  return onClose;
}

describe("the About window", () => {
  it("shows the icon, the name, this build's version and when it was built, what Qnet does and the copyright (ABOUT-002, ABOUT-003)", async () => {
    await show();
    expect(screen.getByRole("img", { name: "Qnet application icon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Qnet");
    expect(screen.getByText(`Version ${mockInfo.version} (dev, ${mockInfo.buildTag})`)).toBeInTheDocument();
    expect(screen.getByText("Built 12 May 2026 at 06:06")).toBeInTheDocument();
    expect(screen.getByText("Draws open queueing networks and analyses them with spectral SRBM, finite-element, QNA and simulation solvers.")).toBeInTheDocument();
    expect(screen.getByText("© 2026 Dr Joseph Edward Nemec")).toBeInTheDocument();
  });

  it("leaves the build line out when the build's time can't be read, and falls back to 2026", async () => {
    mockTauri(defaultHandlers());
    mockHelp.builtMs = null;
    render(<AboutView onClose={() => {}} />);
    await screen.findByText((text) => text.startsWith(`Version ${mockInfo.version}`));
    expect(screen.queryByText(/^Built /)).toBeNull();
    expect(screen.getByText("© 2026 Dr Joseph Edward Nemec")).toBeInTheDocument();
    expect(copyrightYear(null)).toBe("2026");
    expect(copyrightYear(new Date(2027, 0, 2).getTime())).toBe("2027");
  });

  it("has Release Notes, Acknowledgements and a Close button that Return activates (ABOUT-004, KEY-031)", async () => {
    const onClose = await show();
    const close = screen.getByRole("button", { name: "Close About window" });
    expect(close).toHaveTextContent("Close");
    expect(close).toHaveAttribute("title", "Close this window");
    expect(close).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("heading", { level: 1 }), { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    const notes = screen.getByRole("button", { name: "Release Notes" });
    expect(notes).toHaveAttribute("title", "Open the Release Notes window");
    expect(releaseNotesOpen()).toBe(false);
    fireEvent.click(notes);
    expect(releaseNotesOpen()).toBe(true);
    // Return on a link is that link's, not Close's.
    fireEvent.keyDown(notes, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("lists what Qnet builds on, with the licences corrected and xterm.js in SwiftTerm's place (ABOUT-005)", async () => {
    await show();
    const link = screen.getByRole("button", { name: "Acknowledgements" });
    expect(link).toHaveAttribute("title", "Third-party libraries used by Qnet");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(link);
    const list = screen.getByRole("dialog", { name: "Acknowledgements" });
    expect(within(list).getByText("Qnet builds on the following open-source software.")).toBeInTheDocument();
    const rows = [...list.querySelectorAll(".about-ack-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);
    expect(rows.slice(0, 4)).toEqual([
      ["xterm.js", "Embedded terminal emulator (MIT)"],
      ["HiGHS", "Linear-programming backend (MIT)"],
      ["SuiteSparse", "CHOLMOD / UMFPACK sparse solvers (GPL 2.0 or later; other modules LGPL, BSD)"],
      ["libomp", "LLVM OpenMP runtime (Apache 2.0 with LLVM exception)"],
    ]);
    expect(rows).toHaveLength(ACKNOWLEDGEMENTS.length);
    expect(ACKNOWLEDGEMENTS.map((a) => a.name)).not.toContain("SwiftTerm");
    for (const a of ACKNOWLEDGEMENTS) expect(a.licence.length, a.name).toBeGreaterThan(2);
    // Escape closes the list, not the window; the link toggles it.
    expect(fireEvent.keyDown(list, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(link);
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is one fixed-size window, 400 × 392, titled “About Qnet” (ABOUT-001)", async () => {
    mockTauri(defaultHandlers());
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    const opened = vi.spyOn(window, "open").mockImplementation(() => win);
    vi.spyOn(win, "focus").mockImplementation(() => {});
    render(<AboutHost />);
    act(() => openAbout());
    expect(opened).toHaveBeenCalledWith(expect.stringMatching(/^about:blank#aux=about&id=[a-z0-9]+&minw=400&minh=392$/), "qnet-about", "width=400,height=392");
    const body = within(win.document.body);
    expect(await body.findByText((text) => text.startsWith(`Version ${mockInfo.version}`))).toBeInTheDocument();
    expect(win.document.title).toBe("About Qnet");
    act(() => openAbout({ acknowledgements: true }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(await body.findByRole("dialog", { name: "Acknowledgements" })).toBeInTheDocument();
    fireEvent.click(body.getByRole("button", { name: "Close About window" }));
    await waitFor(() => expect(aboutOpen()).toBe(false));
    frame.remove();
  });
});

describe("build stamps (ABOUT-010)", () => {
  it("reads MM.DD.YYYY.HHMM as local time and shows it as “12 May 2026, 06:06”", () => {
    const d = parseStamp("05.12.2026.0606")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 4, 12, 6, 6]);
    expect(dateText(d)).toBe("12 May 2026");
    expect(timeText(d)).toBe("06:06");
    expect(humanReadable(d)).toBe("12 May 2026, 06:06");
    expect(stampText(d)).toBe("05.12.2026.0606");
    expect(stampHumanReadable("09.04.2026.1534")).toBe("4 September 2026, 15:34");
    expect(stampHumanReadable("04.26.2026.1647")).toBe("26 April 2026, 16:47");
  });

  it("falls back to the stamp itself when it can't be read", () => {
    for (const bad of ["", "2026-05-12", "13.01.2026.0000", "02.30.2026.0000", "05.12.2026.2460"]) {
      expect(parseStamp(bad), bad).toBeNull();
      expect(stampHumanReadable(bad)).toBe(bad);
    }
  });
});
