// Help articles are CommonMark files (docs/help/*.md). `marked` tokenises them (its lexer only: no
// HTML is ever produced or injected) and this file turns the tokens into the flat list of typeset
// blocks 0.90.34's `HelpMarkup` produced from its ASCII texts — title, headline, paragraph, bullet,
// code — plus a table block, so search, the match walker and the plain-text destinations work a
// block at a time as they did (ledger HELP-010, HELP-014…018). Raw HTML in an article is dropped,
// except a comment of the form `<!-- generated: name -->`, which marks where a generated part goes
// (the Keyboard Shortcuts tables).
//
// New in 2.1: a paragraph that is nothing but one link to `qnet-example:<name>` or
// `qnet-example:<folder>/<name>` for an example in a subfolder of examples/ (optionally
// `?run=<Run-menu command id>`) is an example block: the article offers a bundled example network,
// and Help draws it as buttons ("Open This Example", "Open and Run"). The link's own text is what
// search and the plain-text destinations read.
import { lexer, type Token, type Tokens } from "marked";

export type Inline =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { kind: "title"; inline: Inline[]; text: string }
  | { kind: "headline"; depth: number; inline: Inline[]; text: string }
  | { kind: "paragraph"; level: number; inline: Inline[]; text: string }
  | { kind: "bullet"; level: number; marker: string; inline: Inline[]; text: string }
  | { kind: "code"; level: number; lines: string[]; text: string }
  | { kind: "table"; level: number; header: Inline[][]; rows: Inline[][][]; text: string }
  /** A bundled example the article offers: its name (the file's, without ".bnet") and the method to start, if any. */
  | { kind: "example"; level: number; example: string; run: string | null; text: string };

export const EXAMPLE_SCHEME = "qnet-example:";
// The name may sit in one subfolder of the examples folder ("closed/…", "extended/…"): one plain
// folder name, then the file's name. Nothing else with a slash is an address (no "..", no depth).
const EXAMPLE_LINK = /^qnet-example:((?:[A-Za-z0-9][A-Za-z0-9_-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*)(?:\?run=(run:[a-z][a-z-]*))?$/;

/** What a `qnet-example:` address names, or null when it is not written as one. */
export function exampleTarget(href: string): { example: string; run: string | null } | null {
  const m = EXAMPLE_LINK.exec(href);
  return m ? { example: m[1], run: m[2] ?? null } : null;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

function inlines(tokens: Token[] | undefined, fallback = ""): Inline[] {
  if (!tokens) return fallback ? [{ t: "text", s: decode(fallback) }] : [];
  const out: Inline[] = [];
  const text = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.s += s;
    else out.push({ t: "text", s });
  };
  for (const tok of tokens) {
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        if (t.tokens?.length) for (const i of inlines(t.tokens)) i.t === "text" ? text(i.s) : out.push(i);
        else text(decode(t.text));
        break;
      }
      case "escape":
        text(decode((tok as Tokens.Escape).text));
        break;
      case "codespan":
        out.push({ t: "code", s: decode((tok as Tokens.Codespan).text) });
        break;
      case "strong":
        out.push({ t: "strong", c: inlines((tok as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ t: "em", c: inlines((tok as Tokens.Em).tokens) });
        break;
      case "del":
        for (const i of inlines((tok as Tokens.Del).tokens)) i.t === "text" ? text(i.s) : out.push(i);
        break;
      case "link": {
        const l = tok as Tokens.Link;
        out.push({ t: "link", href: l.href, c: inlines(l.tokens, l.text) });
        break;
      }
      case "image":
        // Help has no pictures; an image's alternative text stands in for it.
        text(decode((tok as Tokens.Image).text));
        break;
      case "br":
        out.push({ t: "br" });
        break;
      case "html":
        // Raw HTML is never rendered.
        break;
      default:
        if ("text" in tok && typeof tok.text === "string") text(decode(tok.text));
    }
  }
  return out;
}

/** An inline run as plain text (what search and the plain-text destinations read). */
export function inlineText(run: Inline[]): string {
  let s = "";
  for (const i of run) {
    if (i.t === "text" || i.t === "code") s += i.s;
    else if (i.t === "br") s += " ";
    else s += inlineText(i.c);
  }
  return s;
}

/** Soft line breaks inside a paragraph are spaces. */
function unwrap(run: Inline[]): Inline[] {
  return run.map((i) => (i.t === "text" ? { t: "text", s: i.s.replace(/\s*\n\s*/g, " ") } : i.t === "strong" || i.t === "em" || i.t === "link" ? { ...i, c: unwrap(i.c) } : i));
}

const GENERATED = /^\s*<!--\s*generated:\s*([a-z-]+)\s*-->\s*$/;

/** Supplies the blocks of a `<!-- generated: name -->` marker. */
export type Generators = Record<string, () => Block[]>;

function walk(tokens: Token[], level: number, out: Block[], gen: Generators, top: { seenTitle: boolean }) {
  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const h = tok as Tokens.Heading;
        const inline = unwrap(inlines(h.tokens, h.text));
        const text = inlineText(inline);
        // The first level-1 heading is the page's title; every other heading is a headline.
        if (h.depth === 1 && !top.seenTitle && level === 0) {
          top.seenTitle = true;
          out.push({ kind: "title", inline, text });
        } else out.push({ kind: "headline", depth: h.depth, inline, text });
        break;
      }
      case "paragraph":
      case "text": {
        const p = tok as Tokens.Paragraph | Tokens.Text;
        const inline = unwrap(inlines(p.tokens, p.text));
        const text = inlineText(inline);
        const only = inline.length === 1 && inline[0].t === "link" ? exampleTarget(inline[0].href) : null;
        if (only && text.trim()) out.push({ kind: "example", level, example: only.example, run: only.run, text });
        else if (text.trim()) out.push({ kind: "paragraph", level, inline, text });
        break;
      }
      case "code": {
        const lines = (tok as Tokens.Code).text.replace(/\n+$/, "").split("\n");
        out.push({ kind: "code", level, lines, text: lines.join(" ") });
        break;
      }
      case "list": {
        const list = tok as Tokens.List;
        let n = typeof list.start === "number" ? list.start : 1;
        for (const item of list.items) {
          const marker = list.ordered ? `${n++}.` : "•";
          const kids = item.tokens.filter((t) => t.type !== "space");
          const first = kids[0];
          if (first && (first.type === "text" || first.type === "paragraph")) {
            const inline = unwrap(inlines((first as Tokens.Text).tokens, (first as Tokens.Text).text));
            out.push({ kind: "bullet", level, marker, inline, text: inlineText(inline) });
            walk(kids.slice(1), level + 1, out, gen, top);
          } else {
            out.push({ kind: "bullet", level, marker, inline: [], text: "" });
            walk(kids, level + 1, out, gen, top);
          }
        }
        break;
      }
      case "table": {
        const t = tok as Tokens.Table;
        const header = t.header.map((c) => unwrap(inlines(c.tokens, c.text)));
        const rows = t.rows.map((r) => r.map((c) => unwrap(inlines(c.tokens, c.text))));
        const text = [header, ...rows].map((r) => r.map(inlineText).join(" ")).join(" ");
        out.push({ kind: "table", level, header, rows, text });
        break;
      }
      case "blockquote":
        walk((tok as Tokens.Blockquote).tokens, level + 1, out, gen, top);
        break;
      case "html": {
        const name = GENERATED.exec((tok as Tokens.HTML).text)?.[1];
        if (name && gen[name]) out.push(...gen[name]());
        break;
      }
      // "space", "hr" (0.90.34 dropped lone rule lines, HELP-014) and anything else: nothing.
    }
  }
}

/** A Markdown article as typeset blocks. */
export function parseMarkdown(source: string, generators: Generators = {}): Block[] {
  const out: Block[] = [];
  walk(lexer(source, { gfm: true }), 0, out, generators, { seenTitle: false });
  return out;
}

// ── Headings ────────────────────────────────────────────────────────────────────────────────

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);
/**
 * Ordinary words of three letters or fewer, which are not acronyms. 0.90.34 kept every such word
 * in capitals, so "WHAT IT IS" read "What IT IS" although its own comment promised "When It Works
 * Well"; 2.0 keeps capitals only for words that are not in this list (decision D5).
 */
const WORDS = new Set([
  "it", "is", "be", "do", "if", "no", "so", "up", "we", "us", "he", "me", "my", "go", "am", "how", "why", "not", "all", "any", "are", "can", "has", "had", "its", "may", "new",
  "one", "two", "six", "ten", "out", "own", "run", "see", "set", "use", "was", "who", "per", "get", "add", "but", "nor", "yet", "off", "via", "now", "too", "row", "map", "key",
  "hit", "end", "top", "low", "big", "old", "few", "you", "our", "let", "put", "say", "way", "day", "try", "did", "got", "his", "her", "she", "him", "fix", "tab", "log",
]);
const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();

/**
 * "WHEN IT WORKS WELL" → "When It Works Well" for all-capitals headings; a heading with any
 * lower-case letter is left alone (0.90.34 `capitalizedHeading`, HELP-017). Acronyms of three
 * letters or fewer stay (QNA, SBD, LP, AI); small words after the first are lower-cased.
 */
export function capitalizedHeading(s: string): string {
  const letters = [...s].filter(isLetter);
  if (!letters.length || !letters.every((c) => c === c.toUpperCase())) return s;
  return s
    .split(" ")
    .map((w, idx) => {
      const chars = [...w];
      const lower = w.toLowerCase();
      if (chars.length <= 3 && chars.every((c) => isLetter(c) && c === c.toUpperCase()) && !SMALL.has(lower) && !WORDS.has(lower)) return w;
      if (idx > 0 && SMALL.has(lower)) return lower;
      return lower.slice(0, 1).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** A headline's inline run as it is shown: title-cased when it is all capitals. */
export function shownHeadline(b: Extract<Block, { kind: "headline" }>): Inline[] {
  const shown = capitalizedHeading(b.text);
  if (shown === b.text) return b.inline;
  // Same length, letter for letter: re-case each text leaf in place.
  let at = 0;
  const recase = (run: Inline[]): Inline[] =>
    run.map((i) => {
      if (i.t === "text" || i.t === "code") {
        const s = shown.slice(at, at + i.s.length);
        at += i.s.length;
        return { ...i, s };
      }
      if (i.t === "br") {
        at += 1;
        return i;
      }
      return { ...i, c: recase(i.c) };
    });
  return recase(b.inline);
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────

/** Folds case and diacritics, keeping for every folded character the index it came from. */
function fold(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const ch of f) {
      folded += ch;
      map.push(i);
    }
  }
  map.push(s.length);
  return { folded, map };
}

const foldNeedle = (q: string) => fold(q.trim()).folded;

/** The ranges of `text` that match `query`, ignoring case and diacritics (HELP-010). */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = foldNeedle(query);
  if (!needle) return [];
  const { folded, map } = fold(text);
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(needle, from);
    if (at < 0) break;
    out.push([map[at], map[at + needle.length - 1] + 1]);
    from = at + needle.length;
  }
  return out;
}

/** Whether `text` contains `query`, ignoring case (`localizedCaseInsensitiveContains`). */
export function containsQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

/** A block as shown: a headline's text is the title-cased one. */
export function searchText(b: Block): string {
  return b.kind === "headline" ? capitalizedHeading(b.text) : b.text;
}

/** Indexes of the blocks that contain the query, in reading order. */
export function matchingBlocks(blocks: Block[], query: string): number[] {
  if (!query.trim()) return [];
  const out: number[] = [];
  blocks.forEach((b, i) => {
    if (containsQuery(searchText(b), query)) out.push(i);
  });
  return out;
}

// ── Plain text (the Status and Shell destinations, `--dump-help`) ───────────────────────────

const width = (s: string) => [...s].length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

function tableLines(header: string[], rows: string[][]): string[] {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(width(header[c] ?? ""), ...rows.map((r) => width(r[c] ?? ""))));
  const line = (r: string[]) => widths.map((w, c) => pad(r[c] ?? "", w)).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
}

/**
 * The article as plain text in the shape of 0.90.34's ASCII help: the title underlined with `=`,
 * headlines (in capitals, as written) with `-`, bullets with their marker, code and tables
 * indented four spaces. One blank line between blocks; bullets of one list stay together.
 */
export function plainText(blocks: Block[]): string {
  const out: string[] = [];
  let prev: Block | null = null;
  for (const b of blocks) {
    const indent = "level" in b ? "  ".repeat(b.level) : "";
    const tight = prev?.kind === "bullet" && b.kind === "bullet";
    if (prev && !tight) out.push("");
    switch (b.kind) {
      case "title":
        out.push(b.text, "=".repeat(width(b.text)));
        break;
      case "headline":
        out.push(b.text, "-".repeat(width(b.text)));
        break;
      case "paragraph":
      case "example":
        out.push(indent + b.text);
        break;
      case "bullet":
        out.push(`${indent}  ${b.marker} ${b.text}`.trimEnd());
        break;
      case "code":
        for (const l of b.lines) out.push(`${indent}    ${l}`.trimEnd());
        break;
      case "table":
        for (const l of tableLines(b.header.map(inlineText), b.rows.map((r) => r.map(inlineText)))) out.push(`${indent}    ${l}`);
        break;
    }
    prev = b;
  }
  return out.join("\n") + "\n";
}

/**
 * How Help typesets an article, one block per line, in 0.90.34's `--dump-help` form (HELP-019):
 * "TITLE     | …", "HEADLINE  | …", "PARA      | …", "BULLET<level>   | <marker> …", "CODE      |"
 * followed by "          |   <line>"; a table prints as "TABLE     |" and its rows the same way;
 * an example block (2.1) as "EXAMPLE   | <name>[ <run command>] | <text>".
 */
export function dumpBlocks(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "title":
        out.push(`TITLE     | ${b.text}`);
        break;
      case "headline":
        out.push(`HEADLINE  | ${b.text}`);
        break;
      case "paragraph":
        out.push(`PARA      | ${b.text}`);
        break;
      case "bullet":
        out.push(`BULLET${b.level}   | ${b.marker} ${b.text}`);
        break;
      case "example":
        out.push(`EXAMPLE   | ${b.example}${b.run ? ` ${b.run}` : ""} | ${b.text}`);
        break;
      case "code":
        out.push("CODE      |");
        for (const l of b.lines) out.push(`          |   ${l}`);
        break;
      case "table":
        out.push("TABLE     |");
        for (const l of tableLines(b.header.map(inlineText), b.rows.map((r) => r.map(inlineText)))) out.push(`          |   ${l}`);
        break;
    }
  }
  return out.join("\n") + "\n";
}
