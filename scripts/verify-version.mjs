#!/usr/bin/env node
// One version, written in several places: this check fails when they disagree (ledger INV-041;
// 0.90.34's verify_source_package.sh asserted its version in the source, the bundle's Info.plist
// and the bundled executable). The version that counts is src-tauri/tauri.conf.json's: Tauri
// stamps it into Info.plist and About reads it back. Everything else must say the same:
//
//   package.json, package-lock.json (two places)
//   every workspace crate's Cargo.toml (or the workspace's, for `version.workspace = true`)
//   Cargo.lock's entry for each of those crates
//   the release notes' running-build entry (src/windows/releasenotes/changelog.ts)
//   the browser preview's About and settings export (src/dev/mock/core.ts, settings.ts)
//   the Python package `qnet` (python/pyproject.toml's [project] version, python/qnet/__init__.py's __version__)
//   README.md's heading ("# Qnet <major>.<minor>")
//
//   node scripts/verify-version.mjs                 the checkout this script is in
//   node scripts/verify-version.mjs --root <dir>    another checkout
//   node scripts/verify-version.mjs --app <Qnet.app>   also a built bundle: Info.plist's
//                                                   CFBundleShortVersionString and CFBundleVersion,
//                                                   and `qnet-cli --version` if the bundle has one
//
// Exit 0 and one line when they agree; otherwise one line per disagreement and exit 1.
// `checkVersions` works on file texts, so src/test/verify-version.test.ts can show each rule bite.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The file whose version the others must repeat. */
export const SOURCE = "src-tauri/tauri.conf.json";

/** The files read besides the crates' Cargo.toml files, which the workspace names. */
export const FIXED_FILES = [
  SOURCE,
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "src/windows/releasenotes/changelog.ts",
  "src/dev/mock/core.ts",
  "src/dev/mock/settings.ts",
  "python/pyproject.toml",
  "python/qnet/__init__.py",
  "README.md",
];

/** A TOML text as its tables in order: `[header]` or `[[header]]`, and the lines under each. */
function tomlTables(text) {
  const tables = [{ header: "", body: "" }];
  for (const line of text.split("\n")) {
    const m = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(#.*)?$/.exec(line);
    if (m) tables.push({ header: m[1], body: "" });
    else tables[tables.length - 1].body += line + "\n";
  }
  return tables;
}
/** `key = "value"` in a table's lines. */
const tomlString = (body, key) => new RegExp(`^\\s*${key.replace(".", "\\.")}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1];

/** The workspace's member folders, from the root Cargo.toml. */
export function workspaceMembers(rootCargo) {
  const ws = tomlTables(rootCargo).find((t) => t.header === "workspace");
  const list = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(ws?.body ?? "")?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Every place the version is written, as { file, where, version }, and what is wrong.
 * `files` maps a path relative to the checkout to its text; a file that is missing is a problem.
 */
export function checkVersions(files) {
  const sites = [];
  const problems = [];
  const site = (file, where, version) => {
    if (typeof version === "string" && version) sites.push({ file, where, version });
    else problems.push(`${file}: no version found (${where})`);
  };
  const text = (file) => {
    if (typeof files[file] === "string") return files[file];
    problems.push(`${file}: missing`);
    return null;
  };
  const json = (file) => {
    const t = text(file);
    if (t === null) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      problems.push(`${file}: not JSON (${e.message})`);
      return null;
    }
  };

  const conf = json(SOURCE);
  if (conf) site(SOURCE, "version", conf.version);
  const pkg = json("package.json");
  if (pkg) site("package.json", "version", pkg.version);
  const lock = json("package-lock.json");
  if (lock) {
    site("package-lock.json", "version", lock.version);
    site("package-lock.json", 'packages[""].version', lock.packages?.[""]?.version);
  }

  const rootCargo = text("Cargo.toml");
  const cargoLock = text("Cargo.lock");
  if (rootCargo !== null) {
    const members = workspaceMembers(rootCargo);
    if (!members.length) problems.push("Cargo.toml: no workspace members found");
    const shared = tomlString(tomlTables(rootCargo).find((t) => t.header === "workspace.package")?.body ?? "", "version");
    const locked = new Map();
    for (const t of tomlTables(cargoLock ?? "")) if (t.header === "package") locked.set(tomlString(t.body, "name"), [...(locked.get(tomlString(t.body, "name")) ?? []), tomlString(t.body, "version")]);
    for (const member of members) {
      const file = `${member}/Cargo.toml`;
      const t = text(file);
      if (t === null) continue;
      const body = tomlTables(t).find((x) => x.header === "package")?.body ?? "";
      const inherits = /^\s*version\.workspace\s*=\s*true|^\s*version\s*=\s*\{\s*workspace\s*=\s*true\s*\}/m.test(body);
      if (inherits) site("Cargo.toml", `[workspace.package] version, for ${member}`, shared);
      else site(file, "[package] version", tomlString(body, "version"));
      const name = tomlString(body, "name");
      if (!name) problems.push(`${file}: no [package] name`);
      else if (cargoLock !== null) {
        const versions = locked.get(name) ?? [];
        if (versions.length !== 1) problems.push(`Cargo.lock: ${versions.length} entries for ${name}, expected one (run cargo build to refresh it)`);
        else site("Cargo.lock", `package ${name}`, versions[0]);
      }
    }
  }

  const changelog = text("src/windows/releasenotes/changelog.ts");
  if (changelog !== null) site("src/windows/releasenotes/changelog.ts", "CHANGELOG's first entry, the running build's", /export const CHANGELOG\b[^=]*=\s*\[\s*\{\s*version:\s*"([^"]*)"\s*,\s*timestamp:\s*null\b/.exec(changelog)?.[1]);
  const mockCore = text("src/dev/mock/core.ts");
  if (mockCore !== null) site("src/dev/mock/core.ts", "mockInfo.version", /\bmockInfo\b[^=]*=\s*\{\s*version:\s*"([^"]*)"/.exec(mockCore)?.[1]);
  const mockSettings = text("src/dev/mock/settings.ts");
  if (mockSettings !== null) site("src/dev/mock/settings.ts", "settings_export's version", /\bconst version = "([^" ]*) \(preview\)"/.exec(mockSettings)?.[1]);

  // The Python package over qnet-cli (new in 2.1): it ships in the app and says the app's version.
  const pyproject = text("python/pyproject.toml");
  if (pyproject !== null) site("python/pyproject.toml", "[project] version", tomlString(tomlTables(pyproject).find((t) => t.header === "project")?.body ?? "", "version"));
  const pyInit = text("python/qnet/__init__.py");
  if (pyInit !== null) site("python/qnet/__init__.py", "__version__", /^__version__\s*=\s*"([^"]*)"/m.exec(pyInit)?.[1]);

  const version = sites.find((s) => s.file === SOURCE)?.version ?? null;
  if (version !== null) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${SOURCE}: version "${version}" is not <major>.<minor>.<patch>`);
    for (const s of sites) if (s.version !== version) problems.push(`${s.file}: ${s.where} is "${s.version}", but ${SOURCE} says "${version}"`);
    const readme = text("README.md");
    if (readme !== null) {
      const heading = /^# Qnet (\d+\.\d+)\b/m.exec(readme)?.[1];
      const short = version.split(".").slice(0, 2).join(".");
      if (!heading) problems.push('README.md: no "# Qnet <major>.<minor>" heading');
      else {
        sites.push({ file: "README.md", where: "heading (major.minor)", version: heading });
        if (heading !== short) problems.push(`README.md: the heading says Qnet ${heading}, but ${SOURCE} says "${version}"`);
      }
    }
  }
  return { version, sites, problems };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The texts checkVersions reads, from a checkout (default: this repository). */
export function readRepository(root = resolve(HERE, "..")) {
  const files = {};
  const read = (file) => {
    const p = join(root, file);
    if (existsSync(p) && statSync(p).isFile()) files[file] = readFileSync(p, "utf8");
  };
  FIXED_FILES.forEach(read);
  for (const member of workspaceMembers(files["Cargo.toml"] ?? "")) read(`${member}/Cargo.toml`);
  return files;
}

/** The problems of a checkout (default: this repository). */
export function verifyRepository(root) {
  return checkVersions(readRepository(root));
}

/** A built Qnet.app against `version`: Info.plist's two version keys and any bundled qnet-cli. */
export function checkBundle(app, version) {
  const problems = [];
  const plist = join(app, "Contents/Info.plist");
  if (!existsSync(plist)) return { problems: [`${app}: no Contents/Info.plist`], checked: 0 };
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    let value;
    try {
      value = execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
    } catch {
      problems.push(`${plist}: no ${key}`);
      continue;
    }
    if (value !== version) problems.push(`${plist}: ${key} is "${value}", but ${SOURCE} says "${version}"`);
  }
  const found = [];
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (st.isFile() && (name === "qnet-cli" || name === "qnet-cli-aarch64-apple-darwin")) found.push(p);
    }
  };
  for (const dir of ["Contents/MacOS", "Contents/Resources"]) if (existsSync(join(app, dir))) walk(join(app, dir), 0);
  for (const cli of found) {
    let said;
    try {
      said = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
    } catch (e) {
      problems.push(`${cli}: --version failed (${e.message.split("\n")[0]})`);
      continue;
    }
    if (said !== `Qnet ${version}`) problems.push(`${cli}: --version prints "${said}", expected "Qnet ${version}"`);
  }
  return { problems, checked: 2 + found.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root;
  let app;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === "--app" && args[i + 1]) app = resolve(args[++i]);
    else {
      console.error("Usage: node scripts/verify-version.mjs [--root <checkout>] [--app <Qnet.app>]");
      process.exit(2);
    }
  }
  const { version, sites, problems } = verifyRepository(root);
  let bundle = "";
  if (app && version !== null) {
    const b = checkBundle(app, version);
    problems.push(...b.problems);
    bundle = ` and ${b.checked} in ${app}`;
  }
  for (const p of problems) console.log(p);
  if (problems.length) {
    console.log(`\nverify-version: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    process.exit(1);
  }
  console.log(`verify-version: ${version} in ${sites.length} places${bundle}, all agree`);
}
