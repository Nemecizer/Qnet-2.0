// Every word the update sheet, its menu item and Settings ▸ General ▸ Updates show.

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export const updateWords = {
  menuTitle: "Check for Updates…",
  menuHelp: "Ask whether a newer version of Qnet exists",
  group: "Qnet",

  ok: "OK",
  cancel: "Cancel",

  disabledTitle: "This copy of Qnet does not check for updates.",
  disabledBody: "It was built without an update address, so it never contacts a server to look for one. When a newer Qnet is published, get it from the place this copy came from.",

  checkingTitle: "Checking for updates…",
  checkingBody: "Qnet is asking its update server whether a newer version exists.",

  upToDateTitle: "Qnet is up to date.",
  upToDateBody: (version: string) => `Version ${version} is the newest version.`,

  availableTitle: (version: string) => `Qnet ${version} is available.`,
  availableBody: (current: string, date: string | null) => `You have version ${current}.${date ? ` The new version was published on ${date}.` : ""}`,
  notesLabel: "What’s new",
  noNotes: "No release notes were published with this version.",
  install: "Install and Relaunch",
  later: "Later",
  skip: "Skip This Version",

  waitInstallTitle: "A solver run is in progress.",
  waitInstallBody: (version: string) => `Qnet ${version} will be installed when the run finishes, so the run is not interrupted. You can keep working.`,
  stopAndInstall: "Stop the Run and Install",
  notNow: "Not Now",

  downloadingTitle: (version: string) => `Downloading Qnet ${version}…`,
  downloadingBody: "The download is checked against the author’s signature before anything is installed.",
  progressLabel: "Download progress",
  progress: (downloaded: number, total: number | null) => (total ? `${mb(downloaded)} of ${mb(total)}` : mb(downloaded)),

  waitRelaunchTitle: (version: string) => `Qnet ${version} is installed.`,
  waitRelaunchBody: "A solver run is in progress. Qnet will relaunch when it finishes, so the run is not interrupted.",
  stopAndRelaunch: "Stop the Run and Relaunch",
  relaunchLater: "Relaunch Later",

  relaunchingTitle: "Relaunching Qnet…",
  relaunchingBody: "Qnet asks about your open networks as it does when you quit, then opens the new version.",

  readyTitle: (version: string) => `Qnet ${version} is installed.`,
  readyBody: "The new version opens the next time Qnet starts.",
  relaunchNow: "Relaunch Now",

  errorTitle: "Qnet couldn’t update.",
  errorFallback: "Checking for updates didn’t work. This copy of Qnet is unchanged.",
  tryAgain: "Try Again",
  details: "Details",

  settings: {
    footerOff: "This copy of Qnet does not check for updates. It was built without an update address and never contacts a server to look for one.",
    footerOn: "Qnet asks only whether a newer version exists, and sends nothing about your networks. A download is installed only if it carries the author’s signature, and never while a solver is running.",
    checkLabel: "Check now",
    checkCaption: (version: string, last: string | null) => `You have version ${version}.${last ? ` Last checked ${last}.` : ""}`,
    checkButton: "Check for Updates…",
    checkTip: "Ask the update server now whether a newer version exists",
  },
} as const;
