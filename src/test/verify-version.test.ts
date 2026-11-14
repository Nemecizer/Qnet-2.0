// The version is written once per build system and they must agree (ledger INV-041): the same
// check as `node scripts/verify-version.mjs`, on this checkout, and each place shown to bite.
import { describe, expect, it } from "vitest";
import { checkVersions, readRepository, SOURCE, verifyRepository, workspaceMembers } from "../../scripts/verify-version.mjs";
import { mockInfo } from "../dev/mock/core";
import { CHANGELOG } from "../windows/releasenotes/changelog";

const files = readRepository();
const real = checkVersions(files);
const version = real.version!;
const OTHER = "9.8.7";

/** The checkout with one file's text changed. */
const withFile = (file: string, change: (text: string) => string) => checkVersions({ ...files, [file]: change(files[file]) });
const swap = (text: string, from: string, to: string) => {
  expect(text, `the text to change is there: ${from}`).toContain(from);
  return text.replace(from, to);
};

describe("the version check", () => {
  it("finds one version in every place this checkout writes it", () => {
    expect(verifyRepository().problems).toEqual([]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workspaceMembers(files["Cargo.toml"])).toEqual(["src-tauri", "core", "runner", "cli"]);
    expect(real.sites.map((s) => `${s.file}: ${s.where}`)).toEqual([
      "src-tauri/tauri.conf.json: version",
      "package.json: version",
      "package-lock.json: version",
      'package-lock.json: packages[""].version',
      "src-tauri/Cargo.toml: [package] version",
      "Cargo.lock: package qnet",
      "core/Cargo.toml: [package] version",
      "Cargo.lock: package qnet-core",
      "runner/Cargo.toml: [package] version",
      "Cargo.lock: package qnet-runner",
      "cli/Cargo.toml: [package] version",
      "Cargo.lock: package qnet-cli",
      "src/windows/releasenotes/changelog.ts: CHANGELOG's first entry, the running build's",
      "src/dev/mock/core.ts: mockInfo.version",
      "src/dev/mock/settings.ts: settings_export's version",
      "python/pyproject.toml: [project] version",
      "python/qnet/__init__.py: __version__",
      "README.md: heading (major.minor)",
    ]);
    expect(real.sites.slice(0, -1).every((s) => s.version === version)).toBe(true);
  });

  it("reads what the interface shows: the release notes' top entry and the preview's About", () => {
    expect(CHANGELOG[0]).toMatchObject({ version, timestamp: null });
    expect(mockInfo.version).toBe(version);
  });

  it("fails, naming the file, when any one place says another version", () => {
    const cases: [string, (text: string) => string, string][] = [
      ["package.json", (t) => swap(t, `"version": "${version}"`, `"version": "${OTHER}"`), `package.json: version is "${OTHER}", but ${SOURCE} says "${version}"`],
      ["package-lock.json", (t) => swap(t, `"version": "${version}"`, `"version": "${OTHER}"`), `package-lock.json: version is "${OTHER}", but ${SOURCE} says "${version}"`],
      [
        "package-lock.json",
        (t) => {
          const lock = JSON.parse(t);
          lock.packages[""].version = OTHER;
          return JSON.stringify(lock);
        },
        `package-lock.json: packages[""].version is "${OTHER}", but ${SOURCE} says "${version}"`,
      ],
      ...["src-tauri", "core", "runner", "cli"].map((m): [string, (text: string) => string, string] => [
        `${m}/Cargo.toml`,
        (t) => swap(t, `version = "${version}"`, `version = "${OTHER}"`),
        `${m}/Cargo.toml: [package] version is "${OTHER}", but ${SOURCE} says "${version}"`,
      ]),
      ...["qnet", "qnet-core", "qnet-runner", "qnet-cli"].map((name): [string, (text: string) => string, string] => [
        "Cargo.lock",
        (t) => swap(t, `name = "${name}"\nversion = "${version}"`, `name = "${name}"\nversion = "${OTHER}"`),
        `Cargo.lock: package ${name} is "${OTHER}", but ${SOURCE} says "${version}"`,
      ]),
      [
        "src/windows/releasenotes/changelog.ts",
        (t) => swap(t, `version: "${version}",\n    timestamp: null`, `version: "${OTHER}",\n    timestamp: null`),
        `src/windows/releasenotes/changelog.ts: CHANGELOG's first entry, the running build's is "${OTHER}", but ${SOURCE} says "${version}"`,
      ],
      ["src/dev/mock/core.ts", (t) => swap(t, `version: "${version}"`, `version: "${OTHER}"`), `src/dev/mock/core.ts: mockInfo.version is "${OTHER}", but ${SOURCE} says "${version}"`],
      ["src/dev/mock/settings.ts", (t) => swap(t, `"${version} (preview)"`, `"${OTHER} (preview)"`), `src/dev/mock/settings.ts: settings_export's version is "${OTHER}", but ${SOURCE} says "${version}"`],
      ["python/pyproject.toml", (t) => swap(t, `version = "${version}"`, `version = "${OTHER}"`), `python/pyproject.toml: [project] version is "${OTHER}", but ${SOURCE} says "${version}"`],
      ["python/qnet/__init__.py", (t) => swap(t, `__version__ = "${version}"`, `__version__ = "${OTHER}"`), `python/qnet/__init__.py: __version__ is "${OTHER}", but ${SOURCE} says "${version}"`],
      ["README.md", (t) => swap(t, `# Qnet ${version.split(".").slice(0, 2).join(".")}`, "# Qnet 9.8"), `README.md: the heading says Qnet 9.8, but ${SOURCE} says "${version}"`],
    ];
    for (const [file, change, problem] of cases) expect(withFile(file, change).problems, file).toEqual([problem]);
  });

  it("fails everywhere else when tauri.conf.json alone is bumped", () => {
    const bumped = withFile(SOURCE, (t) => swap(t, `"version": "${version}"`, `"version": "${OTHER}"`));
    expect(bumped.version).toBe(OTHER);
    expect(bumped.problems).toHaveLength(real.sites.length - 1);
    expect(bumped.problems.every((p) => !p.startsWith(SOURCE))).toBe(true);
  });

  it("says so when a place is missing, has no version, or the version is not three numbers", () => {
    const { ["package.json"]: _gone, ...rest } = files;
    expect(checkVersions(rest).problems).toEqual(["package.json: missing"]);
    expect(withFile("cli/Cargo.toml", (t) => swap(t, `version = "${version}"\n`, "")).problems).toEqual(["cli/Cargo.toml: no version found ([package] version)"]);
    expect(withFile("src/windows/releasenotes/changelog.ts", (t) => swap(t, `version: "${version}",\n    timestamp: null`, `version: "${version}",\n    timestamp: "11.11.2026.0900"`)).problems).toEqual([
      "src/windows/releasenotes/changelog.ts: no version found (CHANGELOG's first entry, the running build's)",
    ]);
    expect(withFile("Cargo.lock", (t) => swap(t, 'name = "qnet-cli"', 'name = "qnet-tool"')).problems).toEqual(["Cargo.lock: 0 entries for qnet-cli, expected one (run cargo build to refresh it)"]);
    const all = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, t.split(version).join("2.0")]));
    expect(checkVersions(all).problems).toContain(`${SOURCE}: version "2.0" is not <major>.<minor>.<patch>`);
  });

  it("follows a crate that takes the workspace's version", () => {
    const shared = {
      ...files,
      "Cargo.toml": files["Cargo.toml"] + `\n[workspace.package]\nversion = "${OTHER}"\n`,
      "cli/Cargo.toml": swap(files["cli/Cargo.toml"], `version = "${version}"`, "version.workspace = true"),
    };
    expect(checkVersions(shared).problems).toEqual([`Cargo.toml: [workspace.package] version, for cli is "${OTHER}", but ${SOURCE} says "${version}"`]);
    expect(checkVersions({ ...shared, "Cargo.toml": files["Cargo.toml"] + `\n[workspace.package]\nversion = "${version}"\n` }).problems).toEqual([]);
  });
});
