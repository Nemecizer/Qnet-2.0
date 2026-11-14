#!/usr/bin/env node
// The Help lint (PLAN §7 P7: "the Help lint passes"): docs/help/manifest.json and the topic files
// agree with each other, with the Help menu and with every place the interface opens a topic.
//
//   node scripts/help-lint.mjs          prints each problem; exit 1 if there is one
//
// The rules (each problem names its rule):
//   manifest       manifest.json is an array of { id, title, section, file, keywords, kind } with
//                  kind topic | method | guide; the optional windowTitle, subtitle and label are
//                  non-empty strings
//   unique         ids, files and labels are unique; a title is unique within its section
//   order          a section's topics are adjacent (the manifest is the sidebar's order)
//   files          every manifest file exists in docs/help and every .md there is in the manifest
//   empty          a topic opens with one "# " title and has text under it
//   structure      only "# " (once, first) and "## " headings; code fences are closed; no "===="
//                  or "----" rule line of the old plain-text layout is left outside a fence
//   swift          no Swift left over: \( interpolation, \" \n \t \u{…} escapes, """ delimiters,
//                  `static let`, or the SOFT / @@…@@ marks of scripts/help-extract.mjs
//   html           the only raw HTML is a known <!-- generated: … --> marker; keyboardShortcuts
//                  has the shortcuts marker exactly once and no other topic has one
//   links          every [text](help:<id>) names a manifest topic; a link has no empty target; a
//                  [text](qnet-example:<name>[?run=run:<command>]) link is a paragraph of its own
//   commands       every help:topic:<id> and help:ref:<id> written under src/, every topic of
//                  menuSpec's METHOD_REFERENCE and AI_PROVIDER_TOPICS, and every helpTopic named
//                  under src/ is a manifest topic; a Help-menu label is the topic's title
//   menu-arrows    0.90.34's design_lint: menu paths use ▸ ("Settings ▸ Simulation"), never →
//   modifier-order 0.90.34's design_lint: modifiers are written ⌃⌥⇧⌘ (⇧⌘W, not ⌘⇧W)
//   cmd-digit      0.90.34's design_lint: ⌘1–⌘9 are the document tabs, so no topic but Keyboard
//                  Shortcuts cites a bare ⌘<digit>
//   anchor         0.90.34's verify_source_package.sh: the rqna topic carries
//                  "RQNA — REFINED QUEUEING NETWORK ANALYZER"
//   claims         the result-claim vocabulary (ledger INV-043): "certified" and its family
//                  appear only in the topics where 0.90.34 used them, so a new use is looked at
//   product-name   the product is Qnet: "BNET" in capitals names nothing but the default system
//                  prompt, which 2.0 kept word for word ("embedded in BNET"); the .bnet format and
//                  BNAsm's `bnet` binary are lower case
//   menu-path      "Run ▸ Run Infinite Test Set": an item cited under a menu of src/lib/menuSpec.ts
//                  that does not hold it, when another menu does; and "Settings ▸ <pane>" names a
//                  pane title of src/windows/settings/registry.ts
//   tool-count     "the nine-tool catalog", "all nine Qnet tools": the number is the number of
//                  tools in src/panes/ai/tools.ts
//
// Plain Node, no dependencies. src/test/help-content.test.ts runs the same checks under Vitest.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = ["topic", "method", "guide"];
export const GENERATED = { shortcuts: "keyboardShortcuts" };
/** Topics in which 0.90.34 wrote of certifying, each time to say what is and is not certified. */
export const CLAIM_TOPICS = ["adaptiveTruncatedCTMC", "barMomentBounds", "finiteDecomposition", "multiClassSRBM"];
const MENUS = "File|Edit|View|Network|Tools|Run|Test|Window|Help|Settings";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
const literals = (code) => [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

/**
 * What the Help's wording is checked against, read from the sources as text (this script has no
 * TypeScript): each top-level menu's labels (its own items, its submenus' and the tables it
 * spreads in), the Settings pane titles, and the number of AI tools. A part whose source is not
 * among `sources` is null and its check is skipped; a source that no longer reads is a problem.
 */
function vocabulary(sources, bad = () => {}) {
  const find = (name) => Object.entries(sources).find(([p]) => p.replaceAll("\\", "/").endsWith(name))?.[1];
  const out = { menus: null, panes: null, tools: null };

  const spec = find("src/lib/menuSpec.ts");
  if (spec !== undefined) {
    const start = spec.indexOf("export const MENU_SPEC");
    const body = start < 0 ? "" : spec.slice(start, spec.indexOf("\n];", start));
    const tops = [...body.matchAll(/\n {4}submenu: "([^"]+)"/g)];
    if (tops.length < 5) bad("menu-path", "src/lib/menuSpec.ts", "MENU_SPEC's top-level menus could not be read");
    else {
      out.menus = new Map();
      tops.forEach((m, i) => {
        let block = body.slice(m.index, tops[i + 1]?.index);
        // The tables a menu spreads in (PANE_TOGGLES, FOCUS_ITEMS, METHOD_REFERENCE, …).
        for (const c of spec.matchAll(/\nexport const ([A-Z_]+)\b[^=]*=([\s\S]*?);\n/g)) if (c[1] !== "MENU_SPEC" && new RegExp(`\\b${c[1]}\\b`).test(block)) block += c[2];
        out.menus.set(m[1], new Set(literals(block).slice(1).map((l) => l.replace(/…$/, "")).filter((l) => /^[A-Z]/.test(l) && !l.includes("+"))));
      });
    }
  }

  const registry = find("src/windows/settings/registry.ts");
  if (registry !== undefined) {
    const start = registry.indexOf("export const PANES");
    const titles = start < 0 ? [] : [...registry.slice(start, registry.indexOf("\n];", start)).matchAll(/\btitle: "([^"]+)"/g)].map((m) => m[1]);
    if (titles.length === 0) bad("menu-path", "src/windows/settings/registry.ts", "PANES' titles could not be read");
    else out.panes = titles;
  }

  const tools = find("src/panes/ai/tools.ts");
  if (tools !== undefined) {
    const start = tools.indexOf("const SPECS");
    const n = start < 0 ? 0 : [...tools.slice(start, tools.indexOf("\n];", start)).matchAll(/\n {2,4}(?:\{ )?name: "/g)].length;
    if (n === 0) bad("tool-count", "src/panes/ai/tools.ts", "SPECS' tools could not be counted");
    else out.tools = n;
  }
  return out;
}

/** A topic's text with fenced code blanked (line count kept), and whether every fence closed. */
function outsideFences(text) {
  let open = null;
  const lines = text.split("\n").map((line) => {
    const m = /^\s*(`{3,})/.exec(line);
    if (open === null) {
      if (m) { open = m[1].length; return ""; }
      return line;
    }
    if (m && m[1].length >= open && line.trim() === m[1]) open = null;
    return "";
  });
  return { lines, closed: open === null };
}

/** Inline code spans blanked, so their contents are not read as markup. */
const withoutCodeSpans = (line) => line.replace(/(`+)(?:(?!\1).)+\1/g, (m) => " ".repeat(m.length));

/**
 * The checks, on data: `manifest` (parsed JSON), `files` (file name → text, the .md files of
 * docs/help) and `sources` (path → text, the .ts/.tsx files under src/). Returns the problems,
 * each "rule: where: what"; empty when the Help is sound.
 */
export function lintHelp({ manifest, files, sources = {} }) {
  const problems = [];
  const bad = (rule, where, what) => problems.push(`${rule}: ${where}: ${what}`);

  // manifest
  if (!Array.isArray(manifest)) return ["manifest: manifest.json: not an array"];
  const str = (v) => typeof v === "string" && v.trim() !== "";
  const entries = manifest.filter((e, i) => {
    const where = `manifest.json[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) { bad("manifest", where, "not an object"); return false; }
    let ok = true;
    for (const k of ["id", "title", "section", "file"]) if (!str(e[k])) { bad("manifest", where, `"${k}" is missing or empty`); ok = false; }
    if (str(e.id) && !/^[A-Za-z][A-Za-z0-9]*$/.test(e.id)) { bad("manifest", where, `id "${e.id}" is not a plain identifier`); ok = false; }
    if (!Array.isArray(e.keywords) || !e.keywords.every(str)) bad("manifest", where, `"keywords" is not an array of non-empty strings`);
    if (!KINDS.includes(e.kind)) bad("manifest", where, `"kind" is ${JSON.stringify(e.kind)}, not one of ${KINDS.join(", ")}`);
    for (const k of ["windowTitle", "subtitle", "label"]) if (k in e && !str(e[k])) bad("manifest", where, `"${k}" is empty`);
    if (str(e.file) && !/^[A-Za-z0-9_-]+\.md$/.test(e.file)) { bad("manifest", where, `file "${e.file}" is not a plain .md name`); ok = false; }
    return ok;
  });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const vocab = vocabulary(sources, bad);
  const menuNames = vocab.menus ? [...vocab.menus.keys()].join("|") : null;

  // unique, order
  const seen = { id: new Set(), file: new Set(), label: new Set(), title: new Set() };
  const closed = new Set();
  let section = null;
  for (const e of entries) {
    for (const [k, v] of [["id", e.id], ["file", e.file], ["label", e.label], ["title", `${e.section} ▸ ${e.title}`]]) {
      if (v === undefined) continue;
      if (seen[k].has(v)) bad("unique", e.id, `${k} "${v}" is used twice`);
      seen[k].add(v);
    }
    if (e.section !== section) {
      if (closed.has(e.section)) bad("order", e.id, `section "${e.section}" is split in two`);
      if (section !== null) closed.add(section);
      section = e.section;
    }
  }

  // files
  for (const e of entries) if (!(e.file in files)) bad("files", e.id, `${e.file} does not exist`);
  for (const name of Object.keys(files)) if (!seen.file.has(name)) bad("files", name, "is in docs/help but not in the manifest");

  // per topic
  for (const e of entries) {
    const text = files[e.file];
    if (text === undefined) continue;
    const where = e.file;
    const at = (i) => `${where}:${i + 1}`;
    const { lines, closed: fencesClosed } = outsideFences(text);
    const all = text.split("\n");

    // empty
    if (!/^# \S/.test(all[0] ?? "")) bad("empty", where, `does not open with a "# " title`);
    if (all.slice(1).filter((l) => l.trim() !== "" && !/^#{1,6} /.test(l)).length === 0) bad("empty", where, "has no text under its title");

    // structure
    if (!fencesClosed) bad("structure", where, "a code fence is never closed");
    lines.forEach((l, i) => {
      const h = /^(#{1,6}) /.exec(l);
      if (h && h[1].length > 2) bad("structure", at(i), `a level-${h[1].length} heading (only # and ## are used)`);
      if (h && h[1].length === 1 && i !== 0) bad("structure", at(i), "a second # title");
      if (/^\s*(={3,}|-{3,})\s*$/.test(l)) bad("structure", at(i), "a rule line of the plain-text layout");
      if (/\t/.test(l)) bad("structure", at(i), "a tab character");
    });

    // swift
    all.forEach((l, i) => {
      if (/\\\(|\\u\{|\\[nt"0r]/.test(l)) bad("swift", at(i), `a Swift escape or interpolation: ${l.trim().slice(0, 60)}`);
      if (l.includes('"""')) bad("swift", at(i), 'a """ delimiter');
      if (/\bstatic (let|var) \w+ =/.test(l)) bad("swift", at(i), "a Swift declaration");
      if (/[\u0000-\u0008\u000b-\u001f]|@@[A-Z]+@@/.test(l)) bad("swift", at(i), "an extraction mark or control character");
    });

    // html
    let markers = 0;
    lines.forEach((l, i) => {
      let rest = withoutCodeSpans(l);
      rest = rest.replace(/<!-- generated: ([a-z-]+) -->/g, (_, name) => {
        if (GENERATED[name] !== e.id) bad("html", at(i), `the marker "generated: ${name}" does not belong in ${e.id}`);
        else markers++;
        return "";
      });
      if (/<!--|-->/.test(rest)) bad("html", at(i), "an HTML comment that is not a generated-block marker");
      if (/(^|[^\\])<[A-Za-z/!]/.test(rest)) bad("html", at(i), `raw HTML or an unescaped "<": ${l.trim().slice(0, 60)}`);
    });
    const wanted = Object.values(GENERATED).includes(e.id) ? 1 : 0;
    if (markers !== wanted) bad("html", where, `${markers} generated-block markers, expected ${wanted}`);

    // links
    lines.forEach((l, i) => {
      for (const m of withoutCodeSpans(l).matchAll(/(?<!\\)\]\(([^)\s]*)[^)]*\)/g)) {
        const target = m[1];
        if (target === "") bad("links", at(i), "a link with no target");
        else if (target.startsWith("help:")) {
          const id = target.slice(5);
          if (!byId.has(id)) bad("links", at(i), `help:${id} is not a topic`);
        } else if (target.startsWith("qnet-example:")) {
          // 2.1: an example block. Its address is well formed and it stands alone on its line;
          // that the example and the method exist is src/windows/help/examples.test.tsx's check.
          // (<name> may be <folder>/<name> for an example in one subfolder of examples/.)
          if (!/^qnet-example:([A-Za-z0-9][A-Za-z0-9_-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(\?run=run:[a-z][a-z-]*)?$/.test(target)) bad("links", at(i), `"${target}" is not qnet-example:<name> or qnet-example:<name>?run=run:<command>`);
          else if (!/^\[[^\]]+\]\([^)]*\)$/.test(l.trim())) bad("links", at(i), "a qnet-example: link must be a paragraph of its own");
        } else if (!/^(https?:|mailto:|#)/.test(target)) bad("links", at(i), `a link to "${target}" (only help:, http(s): and mailto: links are rendered)`);
      }
    });

    // 0.90.34's design_lint rules, which read its help text raw
    all.forEach((l, i) => {
      if (new RegExp(`(${MENUS}) → [A-Z]`).test(l)) bad("menu-arrows", at(i), `menu paths must use ▸, not →: ${l.trim().slice(0, 60)}`);
      if (/⌘[⌃⌥⇧]/u.test(l)) bad("modifier-order", at(i), "shortcut modifiers must be written ⌃⌥⇧⌘ (⇧⌘W, not ⌘⇧W)");
      if (e.id !== "keyboardShortcuts" && /(^|[^⌃⌥⇧])⌘[1-9]/u.test(l.replaceAll("⌘1–⌘9", ""))) bad("cmd-digit", at(i), "⌘<digit> cited outside Keyboard Shortcuts (⌘1–⌘9 are the document tabs)");
      if (/certif/i.test(l) && !CLAIM_TOPICS.includes(e.id)) bad("claims", at(i), `"certified" is reserved for checked, theorem-backed statements; ${e.id} is not on the reviewed list`);

      // product-name
      if (/\bBNET\b/.test(l.replaceAll("embedded in BNET", ""))) bad("product-name", at(i), `the product is Qnet, not BNET: ${l.trim().slice(0, 60)}`);

      // menu-path: what follows "<Menu> ▸ " (on the next line when the path is wrapped there)
      const after = (m) => l.slice(m.index + m[0].length).trim() || (all[i + 1] ?? "").trim();
      const starts = (rest, label) => rest.startsWith(label) && !/^[A-Za-z0-9]/.test(rest.slice(label.length));
      if (menuNames) {
        for (const m of l.matchAll(new RegExp(`(?<![A-Za-z▸] ?)\\b(${menuNames}) ▸ `, "g"))) {
          const rest = after(m);
          if ([...vocab.menus.get(m[1])].some((label) => starts(rest, label))) continue;
          const home = [...vocab.menus].filter(([name, labels]) => name !== m[1] && [...labels].some((label) => label.includes(" ") && starts(rest, label))).map(([name]) => name);
          if (home.length) bad("menu-path", at(i), `"${m[1]} ▸ ${rest.slice(0, 40)}" is not in the ${m[1]} menu; it is in ${home.join(" and ")}`);
        }
      }
      if (vocab.panes) {
        for (const m of l.matchAll(/\bSettings ▸ /g)) {
          const rest = after(m);
          if (!vocab.panes.some((title) => starts(rest, title))) bad("menu-path", at(i), `"Settings ▸ ${rest.slice(0, 40)}" names no Settings pane (${vocab.panes.join(", ")})`);
        }
      }

      // tool-count
      if (vocab.tools !== null) {
        for (const m of l.matchAll(/\b([A-Za-z]+|\d+)-tool catalog\b|\ball ([A-Za-z]+|\d+) Qnet tools\b/g)) {
          const word = (m[1] ?? m[2]).toLowerCase();
          const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word);
          if (n >= 0 && n !== vocab.tools) bad("tool-count", at(i), `"${m[0]}", but src/panes/ai/tools.ts has ${vocab.tools} tools`);
        }
      }
    });
  }

  // anchor
  if (byId.has("rqna") && files[byId.get("rqna").file] !== undefined && !files[byId.get("rqna").file].includes("RQNA — REFINED QUEUEING NETWORK ANALYZER")) {
    bad("anchor", byId.get("rqna").file, 'does not carry "RQNA — REFINED QUEUEING NETWORK ANALYZER"');
  }

  // commands
  for (const [path, text] of Object.entries(sources)) {
    const lineOf = (index) => `${path}:${text.slice(0, index).split("\n").length}`;
    for (const m of text.matchAll(/help:(topic|ref):([A-Za-z0-9_-]+)/g)) {
      if (!byId.has(m[2])) bad("commands", lineOf(m.index), `help:${m[1]}:${m[2]} names no topic`);
    }
    for (const m of text.matchAll(/\bhelpTopic\s*[:=]\s*\{?\s*"([^"]+)"/g)) {
      if (!byId.has(m[1])) bad("commands", lineOf(m.index), `helpTopic "${m[1]}" names no topic`);
    }
    // The Help menu builds its ids from these two tables of [id, label] pairs.
    for (const name of ["METHOD_REFERENCE", "AI_PROVIDER_TOPICS"]) {
      const start = text.search(new RegExp(`export const ${name}\\b`));
      if (start < 0) continue;
      const end = text.indexOf("\n];", start) >= 0 && name === "METHOD_REFERENCE" ? text.indexOf("\n];", start) : text.indexOf(";\n", start);
      const body = text.slice(start, end < 0 ? undefined : end);
      for (const m of body.matchAll(/\[\s*"([A-Za-z0-9_-]+)"\s*,\s*"([^"]*)"\s*\]/g)) {
        const topic = byId.get(m[1]);
        if (!topic) bad("commands", lineOf(start + m.index), `${name} names "${m[1]}", which is no topic`);
        else if (topic.title !== m[2]) bad("commands", lineOf(start + m.index), `${name} labels ${m[1]} "${m[2]}", but its title is "${topic.title}"`);
      }
    }
  }
  return problems;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything lintHelp reads, from a checkout (default: this repository). */
export function readRepository(root = resolve(HERE, "..")) {
  const helpDir = join(root, "docs/help");
  const manifestPath = join(helpDir, "manifest.json");
  if (!existsSync(manifestPath)) return { manifest: null, files: {}, sources: {}, missing: "docs/help/manifest.json does not exist" };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { manifest: null, files: {}, sources: {}, missing: `docs/help/manifest.json is not JSON: ${e.message}` };
  }
  const files = {};
  for (const name of readdirSync(helpDir)) if (name.endsWith(".md")) files[name] = readFileSync(join(helpDir, name), "utf8");
  const sources = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) sources[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(join(root, "src"))) walk(join(root, "src"));
  return { manifest, files, sources };
}

/** The problems of a checkout (default: this repository). */
export function lintRepository(root) {
  const input = readRepository(root);
  return input.missing ? [`manifest: ${input.missing}`] : lintHelp(input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = readRepository();
  const problems = input.missing ? [`manifest: ${input.missing}`] : lintHelp(input);
  for (const p of problems) console.log(p);
  if (problems.length) {
    console.log(`\nhelp-lint: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    process.exit(1);
  }
  console.log(`help-lint: ${input.manifest.length} topics, ${Object.keys(input.sources).length} source files read, no problems`);
}
