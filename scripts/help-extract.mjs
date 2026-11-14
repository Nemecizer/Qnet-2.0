#!/usr/bin/env node
// Builds docs/help/ (one Markdown file per Help topic, plus manifest.json) from Qnet 0.90.34's
// Swift sources, which stay the source of the words:
//
//   AlgorithmHelp.swift          the per-topic plain-text literals
//   ExactSimulationGuide.swift   the SRBM MLMC guide
//   KeyboardShortcutReference.swift  the static parts of the Keyboard Shortcuts page
//   QnetHelpWindow.swift         HelpTopic (ids, order, groups, titles, subtitles, labels) and
//                                HelpMarkup.parse, the plain-text → blocks converter
//
// The plain text is turned into blocks by a line-for-line port of HelpMarkup.parse (what
// `Qnet --dump-help <topic>` prints), so a block here is exactly a block 0.90.34's Help window
// typeset: title, headline, bullet, monospaced block, paragraph. The blocks are then written as
// CommonMark. No word is changed on the way, except by the tables of help-corrections.mjs:
// CORRECTIONS (sentences of 0.90.34 that are untrue of 2.0, each with its reason) and SUBTITLES;
// LAYOUT moves line breaks where 0.90.34's typesetter misread its own text. A table entry whose
// 0.90.34 text is no longer found stops the script, and so does a topic whose characters (markup
// and white space aside) differ from the corrected Swift text.
//
// Where the Markdown departs from 0.90.34's typesetting, all in parseRun and marked there: a
// compound broken after its hyphen at a line end is closed up; an indented banner over a rule
// stays in its monospaced block; a column-aligned table that starts at the margin is one block.
//
//   node scripts/help-extract.mjs [path to 2_QNET/Sources/Qnet]     writes docs/help/
//   node scripts/help-extract.mjs --dump <topic>                    prints the blocks, as --dump-help did
//   node scripts/help-extract.mjs --corrections                     prints the corrections, tab-separated
//
// Plain Node, no dependencies. Check the result with scripts/help-lint.mjs.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORRECTIONS, LAYOUT, SUBTITLES, KEYWORDS } from "./help-corrections.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = args[0]?.startsWith("--") ? args.shift() : null;
const flagArg = flag === "--dump" ? args.shift() : null;
const SRC = resolve(args[0] ?? join(here, "../../../2_QNET/Sources/Qnet"));
const OUT = join(here, "../docs/help");
const read = (name) => readFileSync(join(SRC, name), "utf8");

// ── Swift literals ──────────────────────────────────────────────────────────────────────────

/** Every `static let <name> = """ … """` of a file: name → text, the closing delimiter's indentation removed. */
function multilineLiterals(source) {
  const out = new Map();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*static let (\w+) = """$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*"""$/.test(lines[j])) j++;
    if (j === lines.length) throw new Error(`unterminated literal ${m[1]}`);
    const indent = lines[j].indexOf('"""');
    const body = lines.slice(i + 1, j).map((l) => {
      if (l.trim() === "") return "";
      if (l.slice(0, indent).trim() !== "") throw new Error(`${m[1]}: line ${i + 2} is indented less than its delimiter`);
      return l.slice(indent);
    });
    const text = body.join("\n");
    if (text.includes("\\")) throw new Error(`${m[1]}: a backslash (escape or interpolation) needs a human`);
    out.set(m[1], text);
    i = j;
  }
  return out;
}

/** A one-line Swift string literal's value (the escapes these files use: \" and \\). */
function unquote(lit) {
  if (/\\[^"\\]/.test(lit)) throw new Error(`escape or interpolation in ${lit}`);
  return lit.replace(/\\(["\\])/g, "$1");
}

/** The static lines of KeyboardShortcutReference.text(): every `out.append("…")`, in order, split where the per-menu tables are generated. */
function shortcutsText(source) {
  const body = source.slice(source.indexOf("static func text() -> String"));
  const loopAt = body.indexOf("let keyWidth");
  const afterAt = body.indexOf('out.append("KEYS NOT PRINTED IN A MENU")');
  if (loopAt < 0 || afterAt < 0) throw new Error("KeyboardShortcutReference.text() changed shape");
  const appended = (s) => [...s.matchAll(/^\s*out\.append\("((?:[^"\\]|\\.)*)"\)$/gm)].map((m) => unquote(m[1]));
  const before = appended(body.slice(0, loopAt));
  const after = appended(body.slice(afterAt));
  // The hand-kept table of keys no menu prints: [(key, what)].
  const tbl = source.slice(source.indexOf("private static let unprintedKeys"));
  const rows = [...tbl.slice(0, tbl.indexOf("\n    ]")).matchAll(/\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g)].map((m) => [unquote(m[1]), unquote(m[2])]);
  if (rows.length < 10) throw new Error("unprintedKeys not found");
  return { before, after, rows };
}

// ── HelpTopic ───────────────────────────────────────────────────────────────────────────────

function helpTopics(source) {
  const enumBody = source.slice(source.indexOf("enum HelpTopic: String"), source.indexOf("// MARK: - Plain-text"));
  const ids = [];
  for (const m of enumBody.slice(0, enumBody.indexOf("var id: String")).matchAll(/^\s*case ([\w, ]+)$/gm)) ids.push(...m[1].split(",").map((s) => s.trim()));
  const groups = new Map([...source.matchAll(/^\s*case (\w+)\s*= "([^"]+)"$/gm)].map((m) => [m[1], m[2]]));
  const section = (name, next) => enumBody.slice(enumBody.indexOf(`var ${name}:`), enumBody.indexOf(next));
  const table = (text) => new Map([...text.matchAll(/case \.(\w+):\s*return "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], unquote(m[2])]));
  const groupOf = new Map();
  for (const m of section("group", "/// Sidebar / menu title").matchAll(/case ([\s\S]*?):\s*return \.(\w+)/g)) for (const id of m[1].matchAll(/\.(\w+)/g)) groupOf.set(id[1], groups.get(m[2]));
  const title = table(section("title", "/// Solver binary"));
  const subtitle = table(section("subtitle", "/// Full title"));
  const windowTitle = table(section("windowTitle", "/// One line for a menu tooltip"));
  const label = table(section("label", "/// Plain-text body"));
  const body = new Map([...section("text", "static func topics").matchAll(/case \.(\w+):\s*return ([\w.()]+)/g)].map((m) => [m[1], m[2]]));
  return ids.map((id) => {
    for (const [what, t] of [["group", groupOf], ["title", title], ["windowTitle", windowTitle], ["label", label], ["text", body]]) if (!t.has(id)) throw new Error(`HelpTopic.${id} has no ${what}`);
    return { id, section: groupOf.get(id), title: title.get(id), windowTitle: windowTitle.get(id), subtitle: subtitle.get(id) ?? null, label: label.get(id), body: body.get(id) };
  });
}

// ── HelpMarkup.parse, line for line (QnetHelpWindow.swift) ──────────────────────────────────

const trim = (s) => s.replace(/^[ \t]+|[ \t]+$/g, "");
const chars = (s) => Array.from(s);
const isRuleLine = (s, ch) => { const t = chars(trim(s)); return t.length >= 3 && t.every((c) => c === ch); };
const indentOf = (s) => /^ */.exec(s)[0].length;
const hasWideGap = (s) => trim(s).includes("   ");
/**
 * 0.90.34 joined the lines of a paragraph or list item with a space, which left "back- pressure"
 * where a compound was broken after its hyphen. SOFT marks such a joint: the --dump output keeps
 * 0.90.34's space there, the Markdown closes it up.
 */
const SOFT = "\u0001";
const joinLines = (pieces) => pieces.reduce((a, p) => (a === "" ? p : a + (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(p) ? SOFT : " ") + p), "");

function bulletMatch(s) {
  const ind = indentOf(s);
  const body = s.slice(ind);
  for (const m of ["•", "-", "*", "→"]) if (body.startsWith(m + " ")) return { marker: m, text: trim(body.slice(m.length + 1)), contIndent: ind + m.length + 1 };
  const d = /^(\p{Nd}+)([.)]) /u.exec(body);
  if (d) { const marker = d[1] + d[2]; return { marker, text: trim(body.slice(marker.length + 1)), contIndent: ind + marker.length + 1 }; }
  return null;
}

function parseRun(lines, md) {
  const out = [];
  // 0.90.34 took any text line over a rule for a heading, so the banner of a quoted solver output
  // (indented, in ExactSimulationGuide) was typeset as a title. For the Markdown an indented rule
  // is part of its monospaced block; --dump keeps 0.90.34's reading.
  const isRule = (s, ch) => isRuleLine(s, ch) && !(md && indentOf(s) >= 4);
  if (lines.length >= 3 && isRule(lines[0], "=") && isRule(lines[2], "=")) return [{ kind: "title", text: trim(lines[1]) }, ...(lines.length > 3 ? parseRun(lines.slice(3), md) : [])];
  if (lines.length >= 2 && isRule(lines[1], "=")) return [{ kind: "title", text: trim(lines[0]) }, ...(lines.length > 2 ? parseRun(lines.slice(2), md) : [])];
  if (lines.length >= 2 && isRule(lines[1], "-")) return [{ kind: "headline", text: trim(lines[0]) }, ...(lines.length > 2 ? parseRun(lines.slice(2), md) : [])];
  if (lines.length === 1 && (isRule(lines[0], "=") || isRule(lines[0], "-"))) return out;

  const hasBullets = lines.some((l) => bulletMatch(l) !== null);
  const maxIndent = Math.max(...lines.map(indentOf));
  const minIndent = Math.min(...lines.map(indentOf));
  const wideGap = lines.some(hasWideGap);

  if (!hasBullets) {
    if (minIndent >= 1 && (maxIndent >= 4 || wideGap)) return [{ kind: "code", lines: lines.map((l) => l.slice(minIndent)) }];
    if (maxIndent < 4 && !wideGap) return [{ kind: "paragraph", text: joinLines(lines.map(trim)) }];
    let n = 0;
    while (n < lines.length && indentOf(lines[n]) === 0) n++;
    const lead = lines.slice(0, n), rest = lines.slice(n);
    if (lead.length && rest.length && rest.every((l) => indentOf(l) >= 1)) {
      const restMin = Math.min(...rest.map(indentOf));
      return [{ kind: "paragraph", text: joinLines(lead.map(trim)) }, { kind: "code", lines: rest.map((l) => l.slice(restMin)) }];
    }
  }

  // A column-aligned table whose first column starts at the margin (the references of "SRBM in an
  // Orthant") fell through to the line-by-line walk below, which cut it into alternating
  // paragraphs and monospaced scraps. For the Markdown such a run stays one monospaced block.
  if (md && !hasBullets && wideGap) {
    if (process.env.HELP_EXTRACT_TRACE) console.error("TABLE RUN:\n" + lines.join("\n") + "\n");
    return [{ kind: "code", lines: lines.map((l) => l.slice(minIndent)) }];
  }

  let para = [], code = [], bullet = null, codeInBullet = false;
  const flushPara = () => { if (para.length) { out.push({ kind: "paragraph", text: joinLines(para) }); para = []; } };
  // `inBullet` is this port's one addition: a monospaced block that 0.90.34 cut out of a list
  // item is written indented under that item, so the Markdown list keeps it.
  const flushCode = () => { if (code.length) { out.push({ kind: "code", lines: code, inBullet: codeInBullet }); code = []; } codeInBullet = false; };
  const flushBullet = () => { if (bullet) { if (bullet.text !== "") out.push({ kind: "bullet", marker: bullet.marker, text: bullet.text, level: bullet.level }); bullet = null; } };

  for (const line of lines) {
    const ind = indentOf(line);
    const m = bulletMatch(line);
    if (m) { flushPara(); flushCode(); flushBullet(); bullet = { marker: m.marker, text: m.text, level: ind >= 5 ? 1 : 0, markerIndent: ind, cont: m.contIndent }; continue; }
    if (bullet) {
      const b = bullet;
      if (ind >= b.cont + 3 || (hasWideGap(line) && ind >= b.markerIndent + 1)) {
        if (b.text !== "") out.push({ kind: "bullet", marker: b.marker, text: b.text, level: b.level });
        bullet = { marker: "", text: "", level: b.level, markerIndent: b.markerIndent, cont: b.cont };
        code.push(line.slice(Math.min(ind, b.cont + 3)));
        codeInBullet = true;
        continue;
      }
      if (ind >= b.markerIndent && ind <= b.cont + 2) {
        flushCode();
        const piece = trim(line);
        bullet.text = joinLines([b.text, piece]);
        continue;
      }
      flushCode();
      flushBullet();
    }
    if (ind >= 4) { flushPara(); code.push(line.slice(4)); }
    else { flushCode(); para.push(trim(line)); }
  }
  flushPara(); flushCode(); flushBullet();
  return out;
}

export function parse(text, md = false) {
  const blocks = [];
  let run = [];
  const flushRun = () => { if (run.length) { blocks.push(...parseRun(run, md)); run = []; } };
  for (const line of text.split("\n")) { if (trim(line) === "") flushRun(); else run.push(line); }
  flushRun();
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (b.kind === "code" && prev?.kind === "code") merged[merged.length - 1] = { ...prev, lines: [...prev.lines, "", ...b.lines] };
    else merged.push(b);
  }
  return merged;
}

/** What `Qnet --dump-help <topic>` printed for these blocks. */
export function dump(blocks) {
  const out = [];
  blocks = blocks.map((b) => (b.text === undefined ? b : { ...b, text: b.text.replaceAll(SOFT, " ") }));
  for (const b of blocks) {
    if (b.kind === "title") out.push(`TITLE     | ${b.text}`);
    else if (b.kind === "headline") out.push(`HEADLINE  | ${b.text}`);
    else if (b.kind === "paragraph") out.push(`PARA      | ${b.text}`);
    else if (b.kind === "bullet") out.push(`BULLET${b.level}   | ${b.marker} ${b.text}`);
    else { out.push("CODE      |"); for (const l of b.lines) out.push(`          |   ${l}`); }
  }
  return out.join("\n");
}

// ── Blocks → CommonMark ─────────────────────────────────────────────────────────────────────

/**
 * Prose as CommonMark that renders the same characters. Balanced `backticks` (0.90.34 wrote
 * program and file names that way) become code spans; everything Markdown would otherwise read as
 * markup is escaped.
 */
export function mdInline(text) {
  text = text.replaceAll(SOFT, "");
  const ticks = (text.match(/`/g) ?? []).length;
  const esc = (s) => s
    .replace(/\\/g, "\\\\")
    .replace(/([*_\[\]<`])/g, "\\$1")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/^([#>+=~]|\d+[.)](?= ))/, (m) => (/^\d/.test(m) ? m.slice(0, -1) + "\\" + m.slice(-1) : "\\" + m));
  if (ticks === 0 || ticks % 2 === 1 || text.includes("``")) return esc(text);
  return text.split("`").map((part, i) => (i % 2 === 1 ? (part.trim() === "" ? "\\`" + esc(part) + "\\`" : "`" + part + "`") : esc(part))).join("");
}

function fence(lines) {
  const longest = Math.max(2, ...lines.join("\n").match(/`+/g)?.map((t) => t.length) ?? []);
  const f = "`".repeat(Math.max(3, longest + 1));
  return [f, ...lines, f];
}

export function toMarkdown(blocks) {
  const out = [];
  let item = null; // the content indent of the list item the last bullet opened
  let top = false; // a top-level item is open, so a second-level bullet can nest under it
  let prev = null;
  const endList = () => { item = null; top = false; };
  for (const b of blocks) {
    if (b.kind === "title") { out.push(`# ${mdInline(b.text)}`, ""); endList(); }
    else if (b.kind === "headline") { out.push(`## ${mdInline(b.text)}`, ""); endList(); }
    else if (b.kind === "paragraph") { out.push(mdInline(b.text), ""); endList(); }
    else if (b.kind === "bullet" && b.marker === "") {
      // Prose that continues a list item after a monospaced block inside it.
      out.push((item ?? "") + mdInline(b.text), "");
    } else if (b.kind === "bullet") {
      // 0.90.34 drew a second-level bullet indented; in Markdown it nests under the item above
      // it, and stands at the margin where there is none (four spaces would make it code).
      const pad = b.level === 1 && top ? "    " : "";
      // Markdown's own marker for •, - and *; an arrow stays an arrow, as 0.90.34 showed it.
      const marker = /^\d/.test(b.marker) ? b.marker : "-";
      const text = b.marker === "→" ? "→ " + mdInline(b.text) : mdInline(b.text);
      // Consecutive items form one tight list.
      if (prev?.kind === "bullet" && prev.marker !== "" && out[out.length - 1] === "") out.pop();
      out.push(`${pad}${marker} ${text}`, "");
      item = pad + " ".repeat(marker.length + 1);
      if (pad === "") top = true;
    } else {
      const pad = b.inBullet && item !== null ? item : "";
      if (!b.inBullet) endList();
      out.push(...fence(b.lines).map((l) => (l === "" ? "" : pad + l)), "");
    }
    prev = b;
  }
  while (out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/**
 * The characters of a text, markup and white space aside: what must be equal between 0.90.34's
 * plain text and the Markdown made from it. Rule lines, list markers, heading marks, fences,
 * backticks and escapes are dropped from both.
 */
export function letters(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*(={3,}|-{3,}|`{3,})\s*$/.test(l))
    .map((l) => l.replace(/^\s*(#{1,2}|[•*-]|\d+[.)]) /, ""))
    .join("")
    .replace(/<!--.*?-->|@@GENERATED@@/g, "")
    .replace(/[`\\\s]/g, "");
}

// ── Build ───────────────────────────────────────────────────────────────────────────────────

const GENERATED_SHORTCUTS = "<!-- generated: shortcuts -->";

function build() {
  const literals = multilineLiterals(read("AlgorithmHelp.swift"));
  const guide = multilineLiterals(read("ExactSimulationGuide.swift")).get("text");
  const keys = shortcutsText(read("KeyboardShortcutReference.swift"));
  const topics = helpTopics(read("QnetHelpWindow.swift"));
  const used = new Set();
  const applied = [];
  for (const [id, sub] of Object.entries(SUBTITLES)) {
    const t = topics.find((x) => x.id === id);
    if (t?.subtitle !== sub.from) throw new Error(`${id}: 0.90.34's subtitle is not "${sub.from}"`);
    t.subtitle = sub.to;
  }
  const docs = topics.map((t) => {
    let text, markdown;
    const squeeze = (x) => x.replace(/\s+/g, "");
    const layout = (s) => {
      for (const l of LAYOUT.filter((l) => l.topic === t.id)) {
        if (squeeze(l.from) !== squeeze(l.to)) throw new Error(`${t.id}: a layout patch may change white space only: ${l.from}`);
        if (s.split(l.from).length !== 2) throw new Error(`${t.id}: layout patch not found exactly once: ${l.from}`);
        s = s.replace(l.from, () => l.to);
      }
      return s;
    };
    const fix = (s0) => {
      let s = layout(s0);
      for (const c of CORRECTIONS.filter((c) => c.topic === t.id)) {
        if (!s.includes(c.from)) continue;
        if (s.split(c.from).length !== 2) throw new Error(`${t.id}: the corrected sentence occurs more than once: ${c.from}`);
        s = s.replace(c.from, () => c.to);
        applied.push(c);
      }
      return s;
    };
    if (t.body === "KeyboardShortcutReference.text()") {
      // The static prose is 0.90.34's; the per-menu tables are generated by the Help window from
      // the live command list, where the marker stands.
      const width = Math.max(...keys.rows.map(([k]) => chars(k).length)) + 2;
      const table = keys.rows.map(([k, what]) => "    " + k + " ".repeat(width - chars(k).length) + what);
      const heading = keys.after.slice(0, 2), rest = keys.after.slice(2);
      text = fix([...keys.before, "@@GENERATED@@", "", ...heading, ...table, ...rest].join("\n"));
      markdown = toMarkdown(parse(text, true)).replace("@@GENERATED@@", GENERATED_SHORTCUTS);
    } else {
      const m = /^(AlgorithmHelp|ExactSimulationGuide)\.(\w+)$/.exec(t.body);
      const raw = m[1] === "ExactSimulationGuide" ? guide : literals.get(m[2]);
      if (raw === undefined) throw new Error(`${t.id}: no literal ${t.body}`);
      used.add(t.body);
      text = fix(raw);
      markdown = toMarkdown(parse(text, true));
    }
    const a = letters(text), b = letters(markdown);
    if (a !== b) {
      let at = 0;
      while (a[at] === b[at]) at++;
      throw new Error(`${t.id}: the Markdown's words differ from the text's: "…${a.slice(Math.max(0, at - 30), at + 30)}" / "…${b.slice(Math.max(0, at - 30), at + 30)}"`);
    }
    return { ...t, text, markdown };
  });
  const missed = CORRECTIONS.filter((c) => !applied.includes(c));
  if (missed.length) throw new Error("corrections whose 0.90.34 sentence was not found:\n" + missed.map((c) => `  ${c.topic}: ${c.from}`).join("\n"));
  return { docs, literals, used };
}

const kindOf = (t) => (t.id === "exactSimulation" ? "guide" : /Methods$/.test(t.section) ? "method" : "topic");

if (flag === "--corrections") {
  for (const c of CORRECTIONS) console.log([c.topic, c.from.replace(/\s+/g, " "), c.to.replace(/\s+/g, " "), c.why].join("\t"));
  for (const [id, c] of Object.entries(SUBTITLES)) console.log([id + " (subtitle)", c.from, c.to, c.why].join("\t"));
} else if (flag === "--dump") {
  const { docs } = build();
  const t = docs.find((d) => d.id === flagArg);
  if (!t) { console.log("Usage: help-extract.mjs --dump <topic>; topics: " + docs.map((d) => d.id).join(" ")); process.exit(1); }
  console.log(dump(parse(t.text)));
} else {
  const { docs, literals, used } = build();
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".md")) unlinkSync(join(OUT, f));
  const manifest = docs.map((t) => {
    writeFileSync(join(OUT, `${t.id}.md`), t.markdown);
    const entry = { id: t.id, title: t.title, section: t.section, file: `${t.id}.md`, keywords: KEYWORDS(t), kind: kindOf(t) };
    // 0.90.34's other names for a topic (HelpTopic.windowTitle, .subtitle, .label), for the window's title bar, sidebar caption and menu tooltip.
    entry.windowTitle = t.windowTitle;
    if (t.subtitle) entry.subtitle = t.subtitle;
    entry.label = t.label;
    return entry;
  });
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const unusedLiterals = [...literals.keys()].filter((k) => !used.has(`AlgorithmHelp.${k}`));
  console.log(`${docs.length} topics written to ${OUT}`);
  console.log(`AlgorithmHelp literals that are no topic: ${unusedLiterals.join(", ")}`);
}
