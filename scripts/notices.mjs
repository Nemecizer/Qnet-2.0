#!/usr/bin/env node
// Third-party notices, regenerated from the lockfiles so they cannot go stale silently.
//
//   node scripts/notices.mjs            write THIRD-PARTY-NOTICES.md and ThirdPartyLicenses/{README.md,npm,rust}
//   node scripts/notices.mjs --check    exit 1 when the committed notices differ from what would be written
//   node scripts/notices.mjs --native   as the first, and also refresh the native libraries' record and
//                                       licence texts from the staged solvers and the manifest of the
//                                       pinned sources they were built from (scripts/build-deps.sh)
//   node scripts/notices.mjs --python   as the first, and also refresh the bundled Python runtime's record
//                                       and licence texts from the runtime scripts/stage-python.sh staged
//   --frameworks DIR                    the Frameworks folder to compare (default: the solver stage's)
//   --python-runtime DIR                the Python runtime to compare (default: the Python stage's)
//   --app Qnet.app                      check a bundle: its Frameworks against the record (versions too),
//                                       its Contents/Resources/python against the Python record, and its
//                                       Contents/Resources/ThirdPartyLicenses against this folder
//
// Sources, all local (nothing is downloaded or installed):
//   Rust   `cargo metadata --offline --locked`: the crates reachable from the app (src-tauri) by normal
//          dependencies for aarch64-apple-darwin, without proc-macro crates and what only they need
//          (those run in the compiler and are not in the binary); licence texts from the crate sources
//          in ~/.cargo/registry/src.
//   npm    package-lock.json: `dependencies` of package.json and what they depend on; texts from
//          node_modules.
//   native ThirdPartyLicenses/native-libraries.json, the committed record of the dylibs in
//          Contents/Frameworks. --native rewrites it from the stage: the stage's deps-manifest.json
//          (written by scripts/build-deps.sh, copied by scripts/stage-solvers.sh) names the source
//          archive, version, sha256 and licence of each component and the libraries built from it,
//          and the licence texts are the ones build-deps.sh copied out of those sources. Each staged
//          dylib is matched to the library build-deps.sh built by LC_UUID (relocation and re-signing
//          leave the UUID alone), so a stage older than the libraries is refused.
//   python ThirdPartyLicenses/python-components.json, the committed copy of the file
//          scripts/stage-python.sh writes beside the runtime it stages (CPython, what is linked into
//          it, NumPy and the libraries inside NumPy's wheel: version, archive, sha256, licence and
//          the licence texts' paths inside the runtime). --python copies that file and the texts it
//          names; identical texts are kept once in ThirdPartyLicenses/python/texts/, and
//          python/texts.json records which runtime file each one is, with its sha256. --check
//          compares the record and every text with the staged runtime when there is one, and
//          --check --app with the bundle's Contents/Resources/python.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TPL = "ThirdPartyLicenses";
const NOTICES = "THIRD-PARTY-NOTICES.md";
const NATIVE_RECORD = `${TPL}/native-libraries.json`;
const PY_RECORD = `${TPL}/python-components.json`;
const PY_DIR = `${TPL}/python`;
const PY_TEXTS = `${PY_DIR}/texts.json`;
const ABOUT = "src/windows/about/acknowledgements.json";
const TARGET = "aarch64-apple-darwin";
const STAGE = path.join(os.homedir(), "Library/Caches/qnet/solvers/stage");
const DEPS = process.env.QNET_DEPS_DIR ?? path.join(os.homedir(), "Library/Caches/qnet/deps");
// Where scripts/stage-python.sh stages (its QNET_PYTHON_CACHE; assemble-bundle.sh's QNET_PYTHON_STAGE).
const PY_STAGE = process.env.QNET_PYTHON_STAGE ?? path.join(process.env.QNET_PYTHON_CACHE ?? path.join(os.homedir(), "Library/Caches/qnet/python"), "stage");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const CHECK = flag("--check");
const NATIVE = flag("--native");
const PYTHON = flag("--python");
const APP = opt("--app");
const FRAMEWORKS = opt("--frameworks") ?? (APP ? path.join(APP, "Contents/Frameworks") : path.join(STAGE, "Frameworks"));

const PY_RUNTIME = opt("--python-runtime") ?? (APP ? path.join(APP, "Contents/Resources/python") : path.join(PY_STAGE, "Resources/python"));

const problems = [];
const warnings = [];
const die = (m) => {
  console.error(`notices: ${m}`);
  process.exit(2);
};
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|patents)/i;
/** One text, however its line ends and trailing blanks were written. */
const normalise = (s) => s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "") + "\n";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── Standard texts for packages that ship none ────────────────────────────────────────────────
const MIT = (who) => `MIT License

Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const BSD3 = (who) => `BSD 3-Clause License

Copyright (c) ${who}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

/** What a licence text is, for its file name. */
function kindOf(text) {
  const t = text.slice(0, 4000);
  const apache = /Apache License\s+Version 2\.0/.test(t);
  const mit = /Permission is hereby granted, free of charge/.test(text);
  if (/Mozilla Public License,? [Vv]ersion 2\.0/.test(t)) return "mpl-2.0";
  if (apache && mit) return "apache-2.0-and-mit";
  if (apache) return "apache-2.0";
  if (/UNICODE LICENSE V3|Unicode,? Inc\./.test(t)) return "unicode-3.0";
  if (mit) return "mit";
  if (/Redistribution and use in source and binary forms/.test(text)) return "bsd";
  if (/Permission to use, copy, modify,? and\/or distribute this software for any/.test(text)) return "isc";
  if (/This software is provided '?as-is'?, without any express or implied/.test(text)) return "zlib";
  if (/Boost Software License/.test(t)) return "bsl-1.0";
  if (/This is free and unencumbered software released into the public domain/.test(t)) return "unlicense";
  if (/CC0 1\.0|Creative Commons/.test(t)) return "cc0-1.0";
  return "other";
}

// ── Rust ──────────────────────────────────────────────────────────────────────────────────────
function rust() {
  let meta;
  try {
    meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--offline", "--locked", "--filter-platform", TARGET], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${path.join(os.homedir(), ".cargo/bin")}:${process.env.PATH}` },
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    die(`cargo metadata --offline --locked failed (are the crates fetched? run a cargo build once):\n${e.stderr ?? e}`);
  }
  const pkg = new Map(meta.packages.map((p) => [p.id, p]));
  const node = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const procMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));
  const normal = (id) => node.get(id).deps.filter((d) => d.dep_kinds.some((k) => k.kind === null)).map((d) => d.pkg);
  const app = meta.packages.find((p) => p.name === "qnet" && !p.source) ?? die("no workspace package named qnet");
  /** What `from` links: itself and its normal dependencies, stopping at proc-macro crates. */
  const reach = (from) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || procMacro(pkg.get(id))) continue;
      seen.add(id);
      stack.push(...normal(id));
    }
    return seen;
  };
  const linked = reach(app.id);
  // The app's own direct dependencies (through the workspace's crates), and which of them bring each crate in.
  const direct = new Set();
  for (const id of linked) if (!pkg.get(id).source) for (const d of normal(id)) if (pkg.get(d).source && linked.has(d)) direct.add(d);
  const via = new Map();
  for (const d of [...direct].sort((a, b) => cmp(pkg.get(a).name, pkg.get(b).name)))
    for (const id of reach(d)) if (id !== d) via.set(id, [...(via.get(id) ?? []), pkg.get(d).name]);

  const crates = [];
  for (const id of linked) {
    const p = pkg.get(id);
    if (!p.source) continue; // Qnet's own crates
    const dir = path.dirname(p.manifest_path);
    if (!fs.existsSync(dir)) die(`the source of ${p.name} ${p.version} is not in the cargo registry (${dir})`);
    const files = fs
      .readdirSync(dir)
      .filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: normalise(fs.readFileSync(path.join(dir, f), "utf8")) }));
    crates.push({
      name: p.name,
      version: p.version,
      licence: (p.license ?? `see ${p.license_file}`).replace(/\s*\/\s*/g, " OR "),
      authors: p.authors ?? [],
      repository: p.repository ?? p.homepage ?? "",
      use: direct.has(id) ? "used directly" : `through ${summarise(via.get(id) ?? [])}`,
      files,
    });
  }
  crates.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));

  // The Apache and MPL texts most crates carry, for the crates that ship no text.
  const common = (kind) => {
    const n = new Map();
    for (const c of crates) for (const f of c.files) if (kindOf(f.text) === kind) n.set(f.text, (n.get(f.text) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || cmp(sha256(a[0]), sha256(b[0])))[0]?.[0];
  };
  for (const c of crates) {
    if (c.files.length) continue;
    const ids = c.licence.split(/\s+(?:OR|AND)\s+|[()]/).map((s) => s.trim()).filter(Boolean);
    const who = `${c.authors.length ? c.authors.join(", ") : `The ${c.name} authors`}${c.repository ? ` (${c.repository})` : ""}`;
    let text;
    if (ids.includes("MIT")) text = MIT(who);
    else if (ids.includes("Apache-2.0")) text = common("apache-2.0");
    else if (ids.includes("MPL-2.0")) text = common("mpl-2.0");
    else if (ids.includes("BSD-3-Clause")) text = BSD3(who);
    if (!text) die(`${c.name} ${c.version} (${c.licence}) ships no licence text and notices.mjs has no standard text for it`);
    c.files = [{ file: null, text: normalise(text) }];
    c.standard = true;
  }
  return crates;
}
const summarise = (names) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

// ── npm ───────────────────────────────────────────────────────────────────────────────────────
const NPM_USE = {
  "@tauri-apps/api": "The page's calls to the app (commands, events, windows, menus)",
  "@tauri-apps/plugin-dialog": "Open, save and message dialogs",
  "@tauri-apps/plugin-opener": "Opening links and files in other apps",
  "@xterm/xterm": "The Shell pane's terminal",
  "@xterm/addon-search": "Find in the Shell pane",
  "@xterm/addon-web-links": "Links in the Shell pane",
  "lucide-react": "Icons",
  marked: "Markdown reader (src/windows/help/markdown.ts)",
  react: "Interface library",
  "react-dom": "Interface library (rendering)",
};
function npm() {
  const lock = JSON.parse(read("package-lock.json"));
  if (!lock.packages) die("package-lock.json has no packages map (lockfileVersion 2 or 3 is needed)");
  /** Node's lookup: the package's own node_modules, then each folder above it. */
  const resolve = (from, name) => {
    let at = from;
    for (;;) {
      const key = `${at ? `${at}/` : ""}node_modules/${name}`;
      if (lock.packages[key]) return key;
      if (!at) return null;
      const up = at.lastIndexOf("/node_modules/");
      at = up < 0 ? "" : at.slice(0, up);
    }
  };
  const seen = new Map();
  const queue = Object.keys(lock.packages[""].dependencies ?? {}).map((n) => ({ from: "", name: n, by: null }));
  while (queue.length) {
    const { from, name, by } = queue.shift();
    const key = resolve(from, name);
    if (!key) {
      if (by === null) die(`package-lock.json has no entry for ${name}`);
      continue; // an optional dependency that is not installed
    }
    if (seen.has(key)) continue;
    const e = lock.packages[key];
    seen.set(key, { name, version: e.version, by });
    for (const d of Object.keys({ ...e.dependencies, ...e.optionalDependencies })) queue.push({ from: key, name: d, by: by ?? name });
  }
  const out = [];
  for (const [key, p] of seen) {
    const dir = path.join(ROOT, key);
    if (!fs.existsSync(dir)) die(`${key} is not installed (run npm ci)`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (manifest.version !== p.version) die(`${key} is ${manifest.version} but package-lock.json says ${p.version} (run npm ci)`);
    const files = fs
      .readdirSync(dir)
      .filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: normalise(fs.readFileSync(path.join(dir, f), "utf8")) }));
    if (!files.length) die(`${key} ships no licence file`);
    out.push({
      name: p.name,
      version: p.version,
      licence: typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "see its licence file"),
      use: NPM_USE[p.name] ?? `Needed by ${p.by}`,
      files,
    });
  }
  return out.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
}

// ── Native libraries ──────────────────────────────────────────────────────────────────────────
// What each component of the deps manifest is, and each library's licence. Licences are stated per
// library, not per component: SuiteSparse ships libraries under different terms.
const COMPONENTS = {
  libomp: { dir: "libomp", source: "https://github.com/llvm/llvm-project" },
  "suite-sparse": { dir: "suite-sparse", source: "https://github.com/DrTimothyAldenDavis/SuiteSparse" },
  highs: { dir: "highs", source: "https://github.com/ERGO-Code/HiGHS" },
  cjson: { dir: "cjson", source: "https://github.com/DaveGamble/cJSON" },
};
const LIB_LICENCE = [
  [/^libomp\./, "Apache-2.0 WITH LLVM-exception"],
  [/^libhighs\./, "MIT"],
  [/^libcjson\./, "MIT"],
  [/^lib(amd|camd|colamd|ccolamd|suitesparseconfig)\./, "BSD-3-Clause"],
  [/^libcxsparse\./, "LGPL-2.1-or-later"],
  [/^libcholmod\./, "LGPL-2.1-or-later AND GPL-2.0-or-later AND Apache-2.0"],
  [/^libumfpack\./, "GPL-2.0-or-later"],
];
/** The libraries whose licence makes a program that links them a GPL work. */
const GPL_LIBRARY = /^lib(umfpack|cholmod)\./;
const libLicence = (lib) => LIB_LICENCE.find(([re]) => re.test(lib))?.[1];
/** The folder of a recorded component's texts: where its files are, whether or not COMPONENTS still knows it. */
const componentDir = (c) => COMPONENTS[c.key]?.dir ?? Object.keys(c.files ?? {})[0]?.split("/")[0] ?? c.key;

const tool = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const uuidOf = (f) => tool("dwarfdump", ["--uuid", f]).split("\n").filter(Boolean).map((l) => l.split(" ")[1]).sort().join("+");
const linksOf = (f) => tool("otool", ["-L", f]).split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
/** `current version` of the library's own id line. */
function dylibVersion(f) {
  const base = path.basename(f);
  const line = tool("otool", ["-L", f]).split("\n").slice(1).find((l) => path.basename(l.trim().split(" ")[0]) === base);
  return line?.match(/current version ([0-9.]+)/)?.[1] ?? "";
}
const dylibs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".dylib")).sort();
function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Rewrites the record and the licence texts from the stage and the manifest of what it was built from. */
function refreshNative() {
  if (!fs.existsSync(FRAMEWORKS)) die(`${FRAMEWORKS} does not exist: run scripts/stage-solvers.sh first`);
  const manifestPath = path.join(path.dirname(FRAMEWORKS), "deps-manifest.json");
  if (!fs.existsSync(manifestPath)) die(`${manifestPath} does not exist: the stage was not made by this scripts/stage-solvers.sh; run it again`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Which component built each library, by the name the solvers load it by.
  const builtBy = new Map();
  for (const c of manifest.components) {
    if (!COMPONENTS[c.key]) die(`${manifestPath} names a component notices.mjs does not know: ${c.key} (add it to COMPONENTS)`);
    for (const l of c.libraries) builtBy.set(l.loaded_as, { component: c, built: path.join(DEPS, "prefix/lib", l.file) });
  }
  // Which solvers load each library, directly.
  const users = new Map();
  const bin = path.join(path.dirname(FRAMEWORKS), "Resources/bin");
  if (fs.existsSync(bin))
    for (const f of walkFiles(bin)) {
      if (!(fs.statSync(f).mode & 0o111) || /\.(py|json|sh|txt)$/.test(f)) continue;
      let links;
      try {
        links = linksOf(f);
      } catch {
        continue;
      }
      for (const l of links) if (l.startsWith("@rpath/")) users.set(l.slice(7), [...(users.get(l.slice(7)) ?? []), path.relative(bin, f)]);
    }
  const used = new Set();
  const libraries = [];
  for (const lib of dylibs(FRAMEWORKS)) {
    const f = path.join(FRAMEWORKS, lib);
    const from = builtBy.get(lib) ?? die(`${lib} is not a library ${manifestPath} lists: only what scripts/build-deps.sh builds may be staged`);
    if (!fs.existsSync(from.built) || uuidOf(from.built) !== uuidOf(f)) die(`${lib} in the stage is not the library in ${path.dirname(from.built)} (by LC_UUID): re-run scripts/stage-solvers.sh`);
    const licence = libLicence(lib) ?? die(`${lib} is new: give it a licence in LIB_LICENCE (scripts/notices.mjs)`);
    used.add(from.component.key);
    libraries.push({
      file: lib,
      component: from.component.key,
      version: dylibVersion(f),
      licence,
      loads: linksOf(f).filter((l) => l.startsWith("@rpath/") && l.slice(7) !== lib).map((l) => l.slice(7)).sort(),
      usedBy: (users.get(lib) ?? []).sort(),
    });
  }
  const record = {
    note: "Written by scripts/notices.mjs --native from the staged solvers and the manifest of the pinned sources their libraries were built from (scripts/build-deps.sh). Do not edit by hand.",
    minimumMacOS: manifest.target.minimum_macos,
    components: [],
    libraries,
  };
  const written = new Map();
  for (const c of manifest.components.filter((c) => used.has(c.key)).sort((a, b) => cmp(a.key, b.key))) {
    const { dir, source } = COMPONENTS[c.key];
    const files = {};
    for (const [name, want] of Object.entries(c.licence_files).sort((a, b) => cmp(a[0], b[0]))) {
      const p = path.join(DEPS, "licenses", c.key, name);
      if (!fs.existsSync(p)) die(`${p} is missing: run scripts/build-deps.sh`);
      const body = fs.readFileSync(p);
      if (sha256(body) !== want) die(`${p} is not the text ${manifestPath} records: run scripts/build-deps.sh --clean`);
      written.set(`${TPL}/${dir}/${name}`, body);
      files[`${dir}/${name}`] = want;
    }
    record.components.push({ key: c.key, name: c.name, version: c.version, source, archive: c.url, sha256: c.sha256, files });
  }
  for (const d of fs.readdirSync(path.join(ROOT, TPL), { withFileTypes: true })) {
    if (d.isDirectory() && !["npm", "rust", "python"].includes(d.name) && !record.components.some((c) => COMPONENTS[c.key].dir === d.name)) {
      fs.rmSync(path.join(ROOT, TPL, d.name), { recursive: true });
      console.log(`removed ${TPL}/${d.name}/`);
    }
  }
  for (const [rel, body] of written) {
    const dir = path.dirname(path.join(ROOT, rel));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), body);
  }
  // A text a component no longer ships.
  for (const c of record.components)
    for (const f of fs.readdirSync(path.join(ROOT, TPL, COMPONENTS[c.key].dir)))
      if (f !== ".DS_Store" && !(`${COMPONENTS[c.key].dir}/${f}` in c.files)) fs.rmSync(path.join(ROOT, TPL, COMPONENTS[c.key].dir, f));
  fs.writeFileSync(path.join(ROOT, NATIVE_RECORD), JSON.stringify(record, null, 2) + "\n");
  console.log(`wrote ${NATIVE_RECORD}: ${libraries.length} libraries from ${record.components.length} components`);
}

/** The committed record, with its licence files and (when there is one) the Frameworks folder checked against it. */
function native() {
  if (!exists(NATIVE_RECORD)) die(`${NATIVE_RECORD} is missing: run node scripts/notices.mjs --native`);
  const record = JSON.parse(read(NATIVE_RECORD));
  // A record written when notices.mjs knew a component it no longer does (or the other way round)
  // is out of date, not a reason to stop with a TypeError further down.
  for (const c of record.components) if (!COMPONENTS[c.key]) problems.push(`${NATIVE_RECORD} names the component “${c.key}”, which notices.mjs does not know: run node scripts/notices.mjs --native (or add it to COMPONENTS)`);
  for (const l of record.libraries) if (!record.components.some((c) => c.key === l.component)) die(`${NATIVE_RECORD}: ${l.file} belongs to the component “${l.component}”, which the record does not list: run node scripts/notices.mjs --native`);
  for (const c of record.components)
    for (const [rel, want] of Object.entries(c.files)) {
      const p = path.join(ROOT, TPL, rel);
      if (!fs.existsSync(p)) problems.push(`${TPL}/${rel} is missing`);
      else if (sha256(fs.readFileSync(p)) !== want) problems.push(`${TPL}/${rel} is not the text ${NATIVE_RECORD} records`);
    }
  for (const l of record.libraries) if (libLicence(l.file) !== l.licence) problems.push(`${l.file}: ${NATIVE_RECORD} says ${l.licence}, notices.mjs says ${libLicence(l.file)}`);
  if (fs.existsSync(FRAMEWORKS)) {
    const have = dylibs(FRAMEWORKS);
    const want = record.libraries.map((l) => l.file);
    for (const f of have) if (!want.includes(f)) problems.push(`${FRAMEWORKS}/${f} has no notice: run node scripts/notices.mjs --native`);
    for (const f of want) if (!have.includes(f)) problems.push(`${f} is in the notices but not in ${FRAMEWORKS}: run node scripts/notices.mjs --native`);
    for (const l of record.libraries) {
      if (!have.includes(l.file)) continue;
      const v = dylibVersion(path.join(FRAMEWORKS, l.file));
      if (v !== l.version) (APP ? problems : warnings).push(`${l.file} is version ${v} in ${FRAMEWORKS}; the notices record ${l.version} (node scripts/notices.mjs --native refreshes them)`);
    }
  } else if (APP) problems.push(`${FRAMEWORKS} does not exist`);
  else warnings.push(`${FRAMEWORKS} does not exist, so the native libraries were checked against the record only`);
  return record;
}

// ── The bundled Python runtime ────────────────────────────────────────────────────────────────
// The libraries NumPy's wheel carries in numpy/.dylibs, each with its licence: a wheel that brings
// another one is refused until it is given a line here (and a look at what its licence asks).
const PY_DYLIB_LICENCE = [
  [/^libscipy_openblas/, "BSD-3-Clause (OpenBLAS, with LAPACK under BSD-3-Clause-Open-MPI)"],
  [/^libgfortran\./, "GPL-3.0-or-later WITH GCC-exception-3.1"],
  [/^libgcc_s\./, "GPL-3.0-or-later WITH GCC-exception-3.1"],
  [/^libquadmath\./, "LGPL-2.1-or-later"],
];
const pyDylibLicence = (file) => PY_DYLIB_LICENCE.find(([re]) => re.test(path.posix.basename(file)))?.[1];
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** A short name for a licence text, from where it sits in the runtime. */
function pyTextSlug(rel) {
  const parts = rel.split("/");
  const own = parts.at(-1).match(/^LICENSE\.(.+)\.txt$/);
  if (parts[0] === "licenses" && own) return slug(own[1]);
  const info = parts.findIndex((x) => x.endsWith(".dist-info"));
  if (info >= 0) {
    const pkg = parts[info].replace(/-[0-9].*$/, "");
    const inner = parts.slice(info + 2, -1); // below <pkg>.dist-info/licenses/
    return slug(inner.length > 1 ? `${pkg}-${inner.at(-1)}` : pkg);
  }
  if (/^lib\/python[0-9.]+\/LICENSE/.test(rel)) return "cpython";
  return slug(parts.at(-1).replace(/\.[a-z]+$/i, "")) || "text";
}
/** Whether `rel` (a path inside the runtime) is one of a component's `files`: itself, or inside a folder entry. */
const pyCovers = (components, rel) => components.some((c) => c.files.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f)));

/** Copies the staged runtime's record and licence texts into the repository. */
function refreshPython() {
  const manifest = path.join(PY_RUNTIME, "../../python-components.json");
  if (!fs.existsSync(path.join(PY_RUNTIME, "bin/python3"))) die(`${PY_RUNTIME} holds no Python runtime: run scripts/stage-python.sh first`);
  if (!fs.existsSync(manifest)) die(`${manifest} does not exist: the runtime was not staged by this scripts/stage-python.sh; run it again`);
  const body = fs.readFileSync(manifest);
  const record = JSON.parse(body);
  const texts = {};
  const keep = new Set(["texts.json"]);
  const dir = path.join(ROOT, PY_DIR);
  fs.mkdirSync(path.join(dir, "texts"), { recursive: true });
  for (const rel of [...new Set(record.components.flatMap((c) => c.licence_texts))].sort()) {
    const p = path.join(PY_RUNTIME, rel);
    if (!fs.existsSync(p)) die(`${manifest} names ${rel}, which is not in ${PY_RUNTIME}: run scripts/stage-python.sh`);
    const text = fs.readFileSync(p);
    const sum = sha256(text);
    // The bytes as the runtime has them: one file for each distinct text, named for the first place it is found.
    const file = Object.values(texts).find((t) => t.sha256 === sum)?.file ?? `texts/${pyTextSlug(rel)}-${sum.slice(0, 10)}.txt`;
    texts[rel] = { file, sha256: sum };
    keep.add(file);
    fs.writeFileSync(path.join(dir, file), text);
  }
  for (const f of walkFiles(dir)) if (!keep.has(path.relative(dir, f))) fs.rmSync(f);
  fs.writeFileSync(path.join(ROOT, PY_RECORD), body);
  const index = {
    note: "Written by scripts/notices.mjs --python from the runtime scripts/stage-python.sh staged. Each licence text python-components.json names (a path inside Contents/Resources/python), the file here that holds the same bytes, and its sha256. Do not edit by hand.",
    texts,
  };
  fs.writeFileSync(path.join(ROOT, PY_TEXTS), JSON.stringify(index, null, 2) + "\n");
  console.log(`wrote ${PY_RECORD} and ${PY_DIR}/: ${record.components.length} components, ${keep.size - 1} distinct licence texts for ${Object.keys(texts).length} licence files`);
}

/** The committed Python record with its texts checked, and (when there is one) the runtime checked against it. */
function python() {
  if (!exists(PY_RECORD)) {
    if (fs.existsSync(PY_RUNTIME)) problems.push(`${PY_RUNTIME} has no notice (${PY_RECORD} is missing): run node scripts/notices.mjs --python`);
    return null;
  }
  const refresh = "run node scripts/notices.mjs --python";
  const record = JSON.parse(read(PY_RECORD));
  const texts = exists(PY_TEXTS) ? JSON.parse(read(PY_TEXTS)).texts : {};
  if (!exists(PY_TEXTS)) problems.push(`${PY_TEXTS} is missing: ${refresh}`);
  const named = new Set(record.components.flatMap((c) => c.licence_texts));
  for (const rel of named) {
    const t = texts[rel];
    if (!t) problems.push(`${PY_TEXTS} has no text for ${rel}: ${refresh}`);
    else if (!exists(`${PY_DIR}/${t.file}`)) problems.push(`${PY_DIR}/${t.file} is missing: ${refresh}`);
    else if (sha256(fs.readFileSync(path.join(ROOT, PY_DIR, t.file))) !== t.sha256) problems.push(`${PY_DIR}/${t.file} is not the text ${PY_TEXTS} records`);
  }
  for (const rel of Object.keys(texts)) if (!named.has(rel)) problems.push(`${PY_TEXTS} lists ${rel}, which ${PY_RECORD} does not name: ${refresh}`);
  if (exists(PY_DIR)) {
    const stored = new Set(["texts.json", ...Object.values(texts).map((t) => t.file)]);
    for (const f of walkFiles(path.join(ROOT, PY_DIR)).map((f) => path.relative(path.join(ROOT, PY_DIR), f)))
      if (!stored.has(f) && path.basename(f) !== ".DS_Store") problems.push(`${PY_DIR}/${f} is no longer needed`);
  }
  for (const c of record.components)
    for (const f of c.files) if (/\.dylib$/.test(f) && !pyDylibLicence(f)) problems.push(`${path.posix.basename(f)} (in the Python runtime) is new: give it a licence in PY_DYLIB_LICENCE (scripts/notices.mjs)`);

  if (fs.existsSync(PY_RUNTIME)) {
    // The stage keeps the file it was described by beside it; a bundle does not carry one.
    const beside = path.join(PY_RUNTIME, "../../python-components.json");
    if (!APP && fs.existsSync(beside) && fs.readFileSync(beside, "utf8") !== read(PY_RECORD)) problems.push(`${beside} differs from ${PY_RECORD}: the staged runtime is not the one the notices describe (${refresh}, or re-run scripts/stage-python.sh)`);
    for (const [rel, t] of Object.entries(texts)) {
      const p = path.join(PY_RUNTIME, rel);
      if (!fs.existsSync(p)) problems.push(`${PY_RUNTIME} lacks the licence text ${rel}`);
      else if (sha256(fs.readFileSync(p)) !== t.sha256) problems.push(`${rel} in ${PY_RUNTIME} is not the text the notices keep (${refresh})`);
    }
    for (const c of record.components) for (const f of c.files) if (!fs.existsSync(path.join(PY_RUNTIME, f))) problems.push(`${c.name}: ${f} is in the notices but not in ${PY_RUNTIME}`);
    // Nothing in the runtime without a notice: every library, every installed package, every licence file.
    const all = walkFiles(PY_RUNTIME).map((f) => path.relative(PY_RUNTIME, f));
    const listed = new Set(record.components.flatMap((c) => c.files));
    for (const f of all) {
      if (f.endsWith(".dylib") && !listed.has(f)) problems.push(`${PY_RUNTIME}/${f} has no notice: ${refresh}`);
      else if (/\.so$/.test(f) && !pyCovers(record.components, f)) problems.push(`${PY_RUNTIME}/${f} has no notice: ${refresh}`);
      else if (f.startsWith("licenses/") && !texts[f]) problems.push(`${PY_RUNTIME}/${f} is a licence text the notices do not keep: ${refresh}`);
    }
    const site = all.map((f) => f.match(/^(lib\/python[0-9.]+\/site-packages\/[^/]+)(\/|$)/)?.[1]).filter(Boolean);
    for (const top of new Set(site)) {
      const info = top.endsWith(".dist-info") && [...named].some((t) => t.startsWith(`${top}/`));
      // (CPython's own entry, the whole lib/python folder, does not vouch for what is installed into it.)
      const owned = record.components.some((c) => c.files.some((f) => f === top || f.startsWith(`${top}/`)));
      if (!info && !owned) problems.push(`${PY_RUNTIME}/${top} is a package with no notice: ${refresh}`);
    }
  } else if (APP) problems.push(`${PY_RUNTIME} does not exist: the bundle has no Python runtime, and the notices say it carries one`);
  else warnings.push(`${PY_RUNTIME} does not exist, so the Python runtime was checked against the record only`);
  return { record, texts };
}

// ── The files ─────────────────────────────────────────────────────────────────────────────────
const md = (s) => String(s).replace(/\|/g, "\\|");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(md).join(" | ")} |`)].join("\n");
const GENERATED = "<!-- Written by scripts/notices.mjs. Do not edit: change the script and run `node scripts/notices.mjs`. -->";

function build() {
  const out = new Map(); // repository path → text
  const record = native();
  const py = python();
  const crates = rust();
  const packages = npm();

  // Rust: each distinct text once, named for what it is and its hash.
  const textName = new Map();
  for (const c of crates)
    for (const f of c.files) {
      if (!textName.has(f.text)) textName.set(f.text, `${c.standard && /^(MIT|BSD)/.test(f.text) ? "standard-" : ""}${kindOf(f.text)}-${sha256(f.text).slice(0, 10)}.txt`);
      f.stored = `texts/${textName.get(f.text)}`;
      out.set(`${TPL}/rust/${f.stored}`, f.text);
    }
  for (const p of packages) for (const f of p.files) out.set(`${TPL}/npm/${p.name}/${f.file}`, f.text);

  const crateRows = (prefix) => crates.map((c) => [c.name, c.version, c.licence, c.use, c.files.map((f) => `[${f.file ?? "standard text"}](${prefix}${f.stored})`).join(", ")]);
  const npmRows = (prefix) => packages.map((p) => [p.name, p.version, p.licence, p.use, p.files.map((f) => `[${f.file}](${prefix}${p.name}/${f.file})`).join(", ")]);
  const noText = crates.filter((c) => c.standard);
  const mpl = crates.filter((c) => /MPL/.test(c.licence));
  const comp = (key) => record.components.find((c) => c.key === key);
  const libRows = record.libraries.map((l) => [l.file, `${comp(l.component).name} ${comp(l.component).version}`, l.version, l.licence, l.usedBy.length ? l.usedBy.map((u) => path.basename(u)).join(", ") : `loaded by ${record.libraries.filter((o) => o.loads.includes(l.file)).map((o) => o.file).join(", ") || "nothing"}`]);
  const compRows = record.components.map((c) => [c.name, c.version, [...new Set(record.libraries.filter((l) => l.component === c.key).map((l) => l.licence))].join("; "), record.libraries.filter((l) => l.component === c.key).map((l) => l.file).join(", "), Object.keys(c.files).map((f) => `[${path.basename(f)}](${TPL}/${f})`).join(", ")]);
  const counts = `${record.libraries.length} native libraries, ${py ? `the ${py.record.components.length} components of the bundled Python runtime, ` : ""}${packages.length} npm packages and ${crates.length} Rust crates`;
  const pyNotes = pythonNotes(py);
  const texts = new Set(textName.values()).size;
  const crateFiles = crates.reduce((n, c) => n + c.files.length, 0);

  const tls = ["aws-lc-sys", "ring"].filter((n) => crates.some((c) => c.name === n));
  // The solver executables that link UMFPACK or CHOLMOD (whose library holds its GPL modules),
  // directly or through another library: `usedBy` and `loads` are otool -L's answers at staging.
  const loadsGpl = (file, seen = new Set()) => {
    if (GPL_LIBRARY.test(file)) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return (record.libraries.find((l) => l.file === file)?.loads ?? []).some((d) => loadsGpl(d, seen));
  };
  const gplUsers = new Map();
  for (const l of record.libraries) if (loadsGpl(l.file)) for (const u of l.usedBy) gplUsers.set(u, [...(gplUsers.get(u) ?? []), ...(GPL_LIBRARY.test(l.file) ? [l.file] : [])]);
  const gplRows = [...gplUsers].sort((a, b) => cmp(a[0], b[0])).map(([u, libs]) => [`\`${path.basename(u)}\``, `\`Contents/Resources/bin/${u}\``, `\`solvers/${path.dirname(u)}/\``, libs.sort().map((f) => f.split(".")[0]).join(", ")]);
  const ss = comp("suite-sparse");
  const position = `### Qnet's licence, and the solvers that are GPL

Qnet's own code is MIT-licensed: the application, the interface, and the source of every solver in
\`solvers/\`. ${gplRows.length} of the solver executables in a built Qnet.app link SuiteSparse's UMFPACK or CHOLMOD, which
contain code under the GNU General Public License. **Those ${gplRows.length} executables are distributed under the
GPL, version 2 or (at your option) any later version (GPL-2.0-or-later)**, with their source
available:

${table(["Executable", "In the app", "Its source", "GPL libraries it links"], gplRows)}

- Their own source is in Qnet's repository, in the folders above. It is MIT-licensed, which the GPL
  accepts in a combined work; the MIT terms continue to apply to that source on its own.
- SuiteSparse ${ss?.version} is built unmodified from ${ss?.archive}
  (sha256 \`${ss?.sha256}\`) by \`scripts/build-deps.sh\`, and \`scripts/stage-solvers.sh\` compiles and links
  the solvers against it: the two scripts are the build.
- The GPL's text is \`${TPL}/suite-sparse/GPL-2.0.txt\`.

Nothing else Qnet's own programs link is under the GPL. The application does not link SuiteSparse:
it starts each solver as a separate program and reads what it prints. The other solver executables
link no GPL library.${pyNotes.gnu ? ` The bundled Python runtime carries GCC's runtime libraries inside NumPy's wheel,
under the GPL version 3 with the GCC Runtime Library Exception; see “The GNU runtime libraries inside
NumPy's wheel” below.` : ""}`;

  const copyleft = `${position}

### Licences that ask for more than a notice

- **SuiteSparse.** UMFPACK (\`libumfpack\`) and CHOLMOD's MatrixOps, Modify and Supernodal modules (in
  \`libcholmod\`) are GPL-2.0-or-later; CHOLMOD's Check, Cholesky, Utility and Partition modules and
  CXSparse are LGPL-2.1-or-later; CHOLMOD's headers are Apache-2.0; AMD, CAMD, COLAMD, CCOLAMD and
  SuiteSparse_config are BSD-3-Clause. The libraries are built unmodified as separate dynamic
  libraries in \`Contents/Frameworks\`, loaded only by solver executables, which run as separate
  processes. What follows for the executables that link the GPL ones is stated above; the LGPL
  libraries can be replaced by a rebuilt copy, since they are separate files. SuiteSparse's source: ${ss?.source}.
- **libomp** is Apache-2.0 with the LLVM exception; its licence file also carries the older
  University of Illinois and MIT terms for parts of the runtime.
- **MPL-2.0 crates** (${mpl.map((c) => `${c.name} ${c.version}`).join(", ")}) are compiled into the application
  unmodified. The Mozilla Public License is a file-level copyleft: the source of those files stays
  available under the MPL, from ${mpl.map((c) => c.repository).filter((r, i, a) => r && a.indexOf(r) === i).join(", ")} and crates.io.
${pyNotes.gnu ? `${pyNotes.gnu}
` : ""}
Nothing else here is copyleft. Unicode-3.0 (the ICU4X crates' data), Zlib, ISC, BSL-1.0, CC0-1.0 and
the Unlicense are permissive${tls.length ? `; ${tls.join(" and ")} (the TLS cryptography, derived from BoringSSL) carry several permissive
licences at once, and their licence files are kept whole` : ""}.`;
  const srcRows = record.components.map((c) => [c.name, c.version, c.archive, `\`${c.sha256}\``]);

  out.set(
    NOTICES,
    `# Third-party notices

${GENERATED}

Qnet's own source is MIT-licensed; see [LICENSE](LICENSE). That licence does not relicense the
third-party components a built Qnet.app carries, which keep their own terms, and the solver
executables that link SuiteSparse's GPL code are distributed under the GPL
([below](#qnets-licence-and-the-solvers-that-are-gpl)). This file lists the components:
${counts}. The licence texts are in [${TPL}/](${TPL}/),
which is copied into the app at \`Contents/Resources/${TPL}\`.

This list is regenerated from \`Cargo.lock\`, \`package-lock.json\` and the records of the staged solver
libraries and of the staged Python runtime by \`node scripts/notices.mjs\`;
\`node scripts/notices.mjs --check\` (run by \`scripts/check.sh\`) fails when it is out of date.

Not listed, because Qnet does not redistribute them: macOS's own frameworks (WebKit, AppKit,
Accelerate, libc++, zlib),${py ? "" : " the Python interpreter and NumPy that some solvers use when they are\ninstalled,"} a Python package a user installs for themselves (CVXPY), and the tools that
only build or test Qnet (TypeScript, Vite, Vitest, the Tauri CLI, CMake and Rust's procedural-macro
crates). The published papers the solvers implement are cited in Help, not redistributed.

## Native libraries (the solvers)

In \`Contents/Frameworks\`, loaded by the solver executables in \`Contents/Resources/bin\`. They are
built by \`scripts/build-deps.sh\` from the unmodified release archives below, each checked against
its sha256, as arm64 libraries for macOS ${record.minimumMacOS} and later; BLAS and LAPACK are macOS's own
Accelerate. Nothing is copied from a package manager.

${table(["Component", "Version", "Licence", "Libraries", "Texts"], compRows)}

${table(["Component", "Version", "Source archive", "sha256"], srcRows)}

${table(["Library", "From", "Library version", "Licence", "Used by"], libRows)}

${copyleft}
${pyNotes.section(`${TPL}/`)}
## The interface (npm packages)

Bundled into the page the app shows. ${packages.length} packages: the \`dependencies\` of \`package.json\` and what they need.

${table(["Package", "Version", "Licence", "Used for", "Texts"], npmRows(`${TPL}/npm/`))}

## The application (Rust crates)

Compiled into the Qnet executable, together with Rust's standard library (MIT OR Apache-2.0).
${crates.length} crates: everything the app links for ${TARGET}. Each distinct licence text is kept
once in \`${TPL}/rust/texts/\` (${texts} texts for ${crateFiles} licence files); texts that differ in anything but line
endings and trailing blanks, a copyright line included, are kept separately. Where a licence
expression offers a choice (\`OR\`), every text the crate ships is kept.${
      noText.length
        ? `\n\n${noText.length} crates ship no licence text in their package (${noText.map((c) => c.name).join(", ")}); for those the standard text of the licence they declare is kept, with the authors and repository from the crate's manifest.`
        : ""
    }

${table(["Crate", "Version", "Licence", "Used", "Texts"], crateRows(`${TPL}/rust/`))}
`,
  );

  out.set(
    `${TPL}/README.md`,
    `# Third-party licences in this build

${GENERATED}

Qnet ${JSON.parse(read("package.json")).version} carries ${counts}. This folder holds their licence texts;
\`THIRD-PARTY-NOTICES.md\` in Qnet's source lists every component with its version and licence.

- ${record.components.map((c) => `\`${componentDir(c)}/\``).join(", ")}: the solvers' native libraries
  (\`Contents/Frameworks\`), with the licence files from the release sources they were built from.
  \`native-libraries.json\` records each component's version, source archive and sha256, and each
  library's version, licence and the solvers that load it.
  \`suite-sparse/LICENSE.txt\` covers all of SuiteSparse, more than the libraries Qnet uses;
  \`GPL-2.0.txt\` and \`LGPL-2.1.txt\` beside it are the licences it names, as SuiteSparse ships them.
${py ? `- \`python/\`: the bundled Python runtime (\`Contents/Resources/python\`). \`python-components.json\` is the
  record \`scripts/stage-python.sh\` writes: each component's version, archive, sha256, licence and the
  licence texts inside the runtime. Each distinct text is kept once in \`python/texts/\`, and
  \`python/texts.json\` says which runtime file each one is; the runtime keeps its own copies too.
` : ""}- \`npm/\`: the interface's packages, one folder each. [npm/INDEX.md](npm/INDEX.md).
- \`rust/\`: the application's crates. [rust/INDEX.md](rust/INDEX.md) names the texts for each crate;
  identical texts are kept once in \`rust/texts/\`.

${table(["Component", "Version", "Licence", "Libraries"], compRows.map((r) => r.slice(0, 4)))}

${copyleft.replaceAll(`${TPL}/`, "")}
${pyNotes.section("")}`,
  );
  out.set(`${TPL}/npm/INDEX.md`, `# npm packages in the interface\n\n${GENERATED}\n\n${table(["Package", "Version", "Licence", "Used for", "Texts"], npmRows(""))}\n`);
  out.set(`${TPL}/rust/INDEX.md`, `# Rust crates in the application\n\n${GENERATED}\n\nRust's standard library (MIT OR Apache-2.0) is linked as well.\n\n${table(["Crate", "Version", "Licence", "Used", "Texts"], crateRows(""))}\n`);

  about(record, crates, packages, py);
  return { out, record, crates, packages, texts, py };
}

/** The Python runtime's section, and the paragraph about the GNU libraries in NumPy's wheel (empty without them). */
function pythonNotes(py) {
  if (!py) return { gnu: "", section: () => "" };
  const { record, texts } = py;
  const where = record.runtime;
  const numpy = record.components.find((c) => c.name === "NumPy");
  const dylibs = record.components.flatMap((c) => c.files.filter((f) => f.endsWith(".dylib")));
  const gnuLibs = dylibs.filter((f) => /GPL/.test(pyDylibLicence(f) ?? ""));
  const names = (fs) => fs.map((f) => `\`${path.posix.basename(f)}\``).join(", ");
  const of = (re) => dylibs.filter((f) => re.test(pyDylibLicence(f) ?? ""));
  const wheelText = (prefix) => {
    const t = texts[dylibs.length ? record.components.find((c) => c.files.includes(dylibs[0])).licence_texts[0] : ""];
    return t ? `\`${prefix}python/${t.file}\`` : "NumPy's licence file";
  };
  const gnu = (prefix) =>
    gnuLibs.length
      ? `- **The GNU runtime libraries inside NumPy's wheel.** NumPy ${numpy?.version}'s wheel carries its own
  linear algebra in \`${where}/${path.posix.dirname(dylibs[0])}/\`: OpenBLAS (${names(of(/^BSD/))}, BSD-3-Clause) and,
  because OpenBLAS's LAPACK is compiled from Fortran, three libraries from GCC: ${names(of(/^GPL-3/))}
  (GPL-3.0-or-later with the GCC Runtime Library Exception 3.1) and ${names(of(/^LGPL/))} (LGPL-2.1-or-later).
  They are the unmodified files of the wheel, inside the Python runtime only: NumPy loads them, and
  neither the application nor any solver executable in \`Contents/Resources/bin\` links them. The GCC
  Runtime Library Exception is what lets libgfortran and libgcc_s be distributed with software under
  other licences; its text and the GPL version 3 are in NumPy's licence file, ${wheelText(prefix)},
  which also states libquadmath's terms. libquadmath is a separate dynamic library, so it can be
  replaced by a rebuilt copy; the LGPL-2.1 text is \`${prefix}suite-sparse/LGPL-2.1.txt\`. Their source is
  GCC's: https://gcc.gnu.org/ (libgfortran, libgcc, libquadmath).`
      : "";
  const link = (prefix, rel) => (texts[rel] ? `[${path.posix.basename(texts[rel].file)}](${prefix}python/${texts[rel].file})` : path.posix.basename(rel));
  const rows = (prefix) => record.components.map((c) => [c.name, c.version ?? "", c.licence, c.role, [...new Set(c.licence_texts.map((t) => link(prefix, t)))].join(", ")]);
  const archives = new Map();
  for (const c of record.components) archives.set(c.url, { sha256: c.sha256, names: [...(archives.get(c.url)?.names ?? []), c.name] });
  const archiveRows = [...archives].map(([url, a]) => [url, `\`${a.sha256}\``, a.names.length > 3 ? `${a.names.slice(0, 2).join(", ")} and ${a.names.length - 2} more` : a.names.join(", ")]);
  const distinct = new Set(Object.values(texts).map((t) => t.file)).size;
  const section = (prefix) => `
## Bundled Python runtime

In \`${where}\`: the Python interpreter and NumPy that Qnet's Python solvers run with, so that no
Python has to be installed. \`scripts/stage-python.sh\` assembles it from the unmodified archives
below, each checked against its sha256: CPython ${record.python} as built by python-build-standalone (arm64,
macOS ${record.minimum_macos} and later), which links the libraries listed with it into the interpreter, and NumPy
${record.numpy}'s wheel from PyPI. Nothing in it is compiled or changed by Qnet; parts a solver has no use for
(the test suites, IDLE, Tk, pip, headers) are left out. The licence texts are the runtime's own
files, kept there and copied to \`${prefix}python/texts/\` (${distinct} distinct texts for ${Object.keys(texts).length} licence files).

${table(["Component", "Version", "Licence", "What it is", "Texts"], rows(prefix))}

${table(["Archive", "sha256", "Components"], archiveRows)}
${gnuLibs.length ? `\n${gnu(prefix).replace(/^- \*\*(.*?)\.\*\* /, "### $1\n\n").replace(/\n  /g, "\n")}\n` : ""}`;
  return { gnu: gnuLibs.length ? "- **The Python runtime** carries GCC's runtime libraries (GPL-3.0-or-later with the GCC Runtime\n  Library Exception; LGPL-2.1-or-later) inside NumPy's wheel; see “The GNU runtime libraries inside\n  NumPy's wheel” below." : "", section };
}

/** About's short list names only things that are really bundled, with the licence the lockfiles give. */
function about(record, crates, packages, py) {
  if (!exists(ABOUT)) return;
  const crate = (n) => crates.find((c) => c.name === n)?.licence;
  const pack = (n) => packages.find((p) => p.name === n)?.licence;
  const libs = (key) => {
    const l = [...new Set(record.libraries.filter((x) => x.component === key).map((x) => x.licence))];
    return l.length ? l.join("; ") : undefined;
  };
  const known = {
    "xterm.js": () => pack("@xterm/xterm"),
    React: () => pack("react"),
    Lucide: () => pack("lucide-react"),
    marked: () => pack("marked"),
    Tauri: () => crate("tauri"),
    "resvg, krilla": () => [crate("resvg"), crate("krilla")].every(Boolean) && `${crate("resvg")}; ${crate("krilla")}`,
    rustls: () => crate("rustls"),
    HiGHS: () => libs("highs"),
    SuiteSparse: () => libs("suite-sparse"),
    libomp: () => libs("libomp"),
    cJSON: () => libs("cjson"),
    Python: () => py?.record.components.find((c) => c.name === "CPython")?.licence,
    NumPy: () => py?.record.components.find((c) => c.name === "NumPy")?.licence,
  };
  for (const a of JSON.parse(read(ABOUT))) {
    if (a.source === "notices") continue; // the line that points at the full list
    const want = known[a.name]?.();
    if (!known[a.name]) problems.push(`${ABOUT}: “${a.name}” is not a component notices.mjs knows (add it to about())`);
    else if (!want) problems.push(`${ABOUT}: “${a.name}” is no longer bundled`);
    else if (a.licence !== want) problems.push(`${ABOUT}: “${a.name}” says ${a.licence}; the bundled component is ${want}`);
  }
}

function generatedOnDisk() {
  const found = [];
  for (const d of ["npm", "rust"]) if (exists(`${TPL}/${d}`)) for (const f of walkFiles(path.join(ROOT, TPL, d))) found.push(path.relative(ROOT, f));
  return found.filter((f) => path.basename(f) !== ".DS_Store");
}

if (NATIVE && !CHECK) refreshNative();
if (PYTHON && !CHECK) refreshPython();
const { out, record, crates, packages, texts, py } = build();

if (CHECK) {
  for (const [rel, text] of out) {
    if (!exists(rel)) problems.push(`${rel} is missing`);
    else if (read(rel) !== text) problems.push(`${rel} is out of date`);
  }
  for (const rel of generatedOnDisk()) if (!out.has(rel)) problems.push(`${rel} is no longer needed`);
  const recorded = new Set(record.components.flatMap((c) => Object.keys(c.files).map((f) => f.split("/")[0])));
  for (const d of fs.readdirSync(path.join(ROOT, TPL), { withFileTypes: true }))
    if (d.isDirectory() && !["npm", "rust", "python"].includes(d.name) && !recorded.has(d.name)) problems.push(`${TPL}/${d.name}/ belongs to nothing that is bundled`);
  if (!py && exists(PY_DIR)) problems.push(`${PY_DIR}/ belongs to nothing that is bundled (${PY_RECORD} is missing)`);
  if (APP) {
    const dir = path.join(APP, "Contents/Resources", TPL);
    if (!fs.existsSync(dir)) problems.push(`${dir} does not exist`);
    else {
      const rels = (base) => walkFiles(base).map((f) => path.relative(base, f)).filter((f) => path.basename(f) !== ".DS_Store").sort();
      const ours = rels(path.join(ROOT, TPL));
      const theirs = rels(dir);
      for (const f of ours) {
        if (!theirs.includes(f)) problems.push(`the bundle lacks ${TPL}/${f}`);
        else if (sha256(fs.readFileSync(path.join(dir, f))) !== sha256(fs.readFileSync(path.join(ROOT, TPL, f)))) problems.push(`the bundle's ${TPL}/${f} differs from the repository's`);
      }
      for (const f of theirs) if (!ours.includes(f)) problems.push(`the bundle has ${TPL}/${f}, which the repository does not`);
    }
  }
} else {
  for (const rel of generatedOnDisk()) if (!out.has(rel)) fs.rmSync(path.join(ROOT, rel));
  let changed = 0;
  for (const [rel, text] of out) {
    if (exists(rel) && read(rel) === text) continue;
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), text);
    changed++;
  }
  // Folders left empty by a package that went away.
  for (const d of ["npm", "rust"]) {
    const prune = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
      if (!fs.readdirSync(dir).filter((f) => f !== ".DS_Store").length) fs.rmSync(dir, { recursive: true });
    };
    if (exists(`${TPL}/${d}`)) prune(path.join(ROOT, TPL, d));
  }
  console.log(`wrote ${changed} of ${out.size} files`);
}

for (const w of warnings) console.error(`notices: warning: ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`notices: ${p}`);
  console.error(CHECK ? "notices: out of date. Run `node scripts/notices.mjs` (with `--native` after re-staging the solvers, `--python` after re-staging the Python runtime), then review the change." : "notices: written, but the problems above remain.");
  process.exit(1);
}
console.log(`notices: ${record.libraries.length} native libraries (${record.components.length} components), ${py ? `${py.record.components.length} Python runtime components (${new Set(Object.values(py.texts).map((t) => t.file)).size} licence texts), ` : ""}${packages.length} npm packages, ${crates.length} Rust crates (${texts} distinct licence texts)${CHECK ? ": up to date" : ""}`);
