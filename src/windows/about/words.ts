// The About window's words, 0.90.34's (AboutQnetWindow.swift `AboutQnetView`; QnetCommands.swift
// `appMenu`). src/lib/vocabulary.ts re-exports them.

export const aboutWords = {
  menuTitle: "About Qnet",
  menuHelp: "Version and build information",
  windowTitle: "About Qnet",
  appName: "Qnet",
  iconLabel: "Qnet application icon",
  version: (label: string) => `Version ${label}`,
  built: (date: string, time: string) => `Built ${date} at ${time}`,
  description: "Draws open queueing networks and analyses them with spectral SRBM, finite-element, QNA and simulation solvers.",
  copyright: (year: string) => `© ${year} Dr Joseph Edward Nemec`,
  releaseNotes: "Release Notes",
  releaseNotesHelp: "Open the Release Notes window",
  acknowledgements: "Acknowledgements",
  acknowledgementsHelp: "Third-party libraries used by Qnet",
  acknowledgementsLead: "Qnet builds on the following open-source software.",
  close: "Close",
  closeHelp: "Close this window",
  closeLabel: "Close About window",
  done: "Done",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number) => String(n).padStart(2, "0");

/** "12 May 2026" (0.90.34 `BuildStamp.dateText`, ABOUT-010). */
export const dateText = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
/** "06:06", 24-hour (`BuildStamp.timeText`). */
export const timeText = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
/** "12 May 2026, 06:06" (`BuildStamp.humanReadable`). */
export const humanReadable = (d: Date) => `${dateText(d)}, ${timeText(d)}`;
/** 0.90.34's stamp form, MM.DD.YYYY.HHMM in local time: "05.12.2026.0606". */
export const stampText = (d: Date) => `${two(d.getMonth() + 1)}.${two(d.getDate())}.${d.getFullYear()}.${two(d.getHours())}${two(d.getMinutes())}`;

/** Reads a 0.90.34 stamp ("04.26.2026.1647") as local time; null when it isn't one. */
export function parseStamp(stamp: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\.(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [mo, day, year, h, min] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const d = new Date(year, mo - 1, day, h, min);
  return d.getMonth() === mo - 1 && d.getDate() === day ? d : null;
}

/** A stamp as people read it, or the stamp itself when it can't be read (`humanReadable`'s fallback). */
export const stampHumanReadable = (stamp: string) => {
  const d = parseStamp(stamp);
  return d ? humanReadable(d) : stamp;
};
