// The Release Notes window's words, 0.90.34's (ReleaseNotesWindow.swift). src/lib/vocabulary.ts
// re-exports them.

export const releaseNotesWords = {
  windowTitle: "Release Notes",
  heading: "Release Notes",
  appLine: (version: string) => `Qnet ${version}`,
  releases: (n: number) => `${n} releases`,
  releasesLabel: (n: number) => `${n} releases listed`,
  expandAll: "Expand All",
  collapseAll: "Collapse All",
  expandAllHelp: "Open every shipped release below the current one",
  collapseAllHelp: "Collapse every shipped release again",
  expandAllLabel: "Expand all releases",
  collapseAllLabel: "Collapse all releases",
  copy: "Copy",
  copied: "Copied",
  copyHelp: "Copy this release's notes as plain text — the entry at the top only, not the whole history",
  copyLabel: "Copy current release notes",
  copiedLabel: "Copied current release notes",
  version: (v: string) => `Version ${v}`,
  inDevelopment: "In development",
  current: "Current",
  currentLabel: "Current release",
  buildTip: (version: string, stamp: string) => `Build ${version}.${stamp}`,
  collapsedLabel: (version: string, date: string) => `Version ${version}, ${date}`,
  /** Debug builds only (ABOUT-016). */
  frozenTop: (fullVersion: string) =>
    `Debug build note: the newest entry below is frozen, so this build (${fullVersion}) has no in-development entry. Prepend one with timestamp: null in src/windows/releasenotes/changelog.ts before the next release.`,
  /** How long "Copied" shows, in milliseconds. */
  copiedFor: 1500,
};
