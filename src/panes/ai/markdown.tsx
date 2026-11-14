// Markdown in assistant replies (0.90.34 AIPaneView.swift `AIMarkdownView`, `AICodeWell`; ledger
// AI-072…074): headings, bulleted and numbered lists with nesting, block quotes, rules, fenced
// code and inline code in the code font, and tables; text that fits none of them is a paragraph.
// 0.90.34 used Foundation's Markdown parser; this is a small one for the same blocks.
import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Icon } from "../../components/Icon";
import type { MenuItem } from "../status/popup";
import { HANDLE_KINDS, num, unitWords, type Fact } from "./explain/facts";
import { FLAGGED, withFlags, withoutFlags, type AnswerCheck, type Finding } from "./explain/verify";
import { aiWords as w } from "./words";

/** What an assistant reply's citations are drawn from: its check, the conversation's facts, and what a chip does. */
export interface Citations {
  check: AnswerCheck | null;
  fact: (handle: string) => Fact | undefined;
  open: (fact: Fact) => void;
}
const CitationsContext = createContext<Citations | null>(null);

/** Why a number is marked, in a sentence. */
export function flagReason(f: Finding): string {
  switch (f.status) {
    case "mismatch":
      return w.flag.mismatch(f.cited);
    case "unit":
      return w.flag.unit(f.cited);
    case "stale":
      return w.flag.stale;
    case "unknown":
      return w.flag.unknown;
    default:
      return w.flag.unverified;
  }
}

/** A handle in a reply, as a chip naming the source of the number before it; clicked, it shows that source. */
function CiteChip({ handle }: { handle: string }) {
  const c = useContext(CitationsContext);
  const fact = c?.fact(handle);
  const use = c?.check?.handles.find((h) => h.handle === handle);
  if (!c || !fact) {
    return (
      <span className="ai-cite" data-state="unknown" title={`${w.chipUnknown}\n[${handle}]`} role="note" aria-label={w.chipUnknown}>
        {w.chipUnknownShort}
      </span>
    );
  }
  const stale = use?.status === "stale";
  const help = fact.kind === "number" ? w.chipHelpFact(fact.what, num(fact.value) + unitWords(fact.unit), fact.tier, fact.source) : w.chipHelpPassage(fact.source);
  // A Help passage is where something was read, not a result: its chip says so and looks it.
  const fromHelp = fact.kind === "text" && fact.target.kind === "help";
  const label = fact.kind === "number" ? `${shortSource(fact.source)} · ${fact.tier}` : fromHelp ? w.chipFromHelp(fact.source.replace(/^Qnet Help:\s*/, "")) : shortSource(fact.source);
  return (
    <button type="button" className="ai-cite" data-state={stale ? "stale" : "known"} data-kind={fromHelp ? "help" : fact.kind === "number" ? "result" : "text"} data-handle={handle} title={stale ? `${w.chipStale}\n${help}` : help} aria-label={stale ? `${w.chipLabelFact(fact.source)}. ${w.chipStale}` : w.chipLabelFact(fact.source)} onClick={() => c.open(fact)}>
      {stale ? `${label} · ${w.chipStaleShort}` : label}
    </button>
  );
}
/** "Product form (run 1a2b3c4d)" → "Product form": the chip is short, its tooltip is whole. */
const shortSource = (source: string) => source.replace(/\s*\(.*$/, "").replace(/,.*$/, "");

export type Align = "left" | "center" | "right";
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "listItem"; marker: string; depth: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][]; alignments: (Align | null)[] }
  | { kind: "rule" };

const FENCE = /^ {0,3}(```+|~~~+)(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The reply as blocks, in order. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  // Indent widths of the open list levels, so nesting follows the source's indentation.
  let levels: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i].trim().startsWith(fence[1][0].repeat(3)) && /^\s*(```+|~~~+)\s*$/.test(lines[i])); i++) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n").replace(/\n+$/, "") });
      levels = [];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      levels = [];
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      levels = [];
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-") && cells(lines[i + 1]).length === cells(line).length) {
      flush();
      levels = [];
      const header = cells(line);
      const alignments = cells(lines[i + 1]).map((c): Align | null => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: "table", header, rows, alignments });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const indent = item[1].replace(/\t/g, "    ").length;
      while (levels.length && indent < levels[levels.length - 1]) levels.pop();
      if (!levels.length || indent > levels[levels.length - 1]) levels.push(indent);
      const ordered = /\d/.test(item[2]);
      blocks.push({ kind: "listItem", marker: ordered ? `${parseInt(item[2], 10)}.` : "•", depth: levels.length, text: item[3] });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      levels = [];
      const last = blocks[blocks.length - 1];
      if (last?.kind === "quote" && i > 0 && QUOTE.test(lines[i - 1])) last.text += `\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1] });
      continue;
    }
    // A continuation line of a list item stays with it.
    const last = blocks[blocks.length - 1];
    if (!para.length && last?.kind === "listItem" && /^\s+\S/.test(line) && i > 0 && lines[i - 1].trim()) {
      last.text += ` ${line.trim()}`;
      continue;
    }
    levels = [];
    para.push(line.trim());
  }
  flush();
  return blocks.length ? blocks : [{ kind: "paragraph", text: source }];
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text with every occurrence of the search query marked (`highlightingMatches(of:)`). */
export function Marked({ text, q }: { text: string; q: string }) {
  const c = useContext(CitationsContext);
  if (text.includes("\uE000")) {
    // Numbers the check could not verify, marked where they stand (./explain/verify.ts `withFlags`).
    const out: ReactNode[] = [];
    let at = 0;
    FLAGGED.lastIndex = 0;
    for (let m = FLAGGED.exec(text); m; m = FLAGGED.exec(text)) {
      if (m.index > at) out.push(<Marked key={`t${at}`} text={text.slice(at, m.index)} q={q} />);
      const finding = c?.check?.flagged[Number(m[1])];
      out.push(
        <span key={`f${m.index}`} className="ai-unverified" data-status={finding?.status ?? "unverified"} title={finding ? flagReason(finding) : w.flag.unverified} role="note" aria-label={`${m[2]}: ${finding ? flagReason(finding) : w.flag.unverified}`}>
          <Marked text={m[2]} q={q} />
          <span className="ai-unverified-word" aria-hidden>{w.flagWord}</span>
        </span>,
      );
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(<Marked key={`t${at}`} text={text.slice(at)} q={q} />);
    return <>{out}</>;
  }
  const t = q.trim();
  if (!t) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(t)})`, "giu"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="ai-match">{p}</mark> : p))}</>;
}

const KINDS = HANDLE_KINDS.join("|");
const INLINE_BASE = /(\`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*|__([^\s_](?:[\s\S]*?[^\s_])?)__|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|(?<![\w])_([^\s_](?:[\s\S]*?[^\s_])?)_(?![\w])|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)/;
const INLINE = new RegExp(`${INLINE_BASE.source}|\\[((?:${KINDS}):[^\\]\\s\\[]{1,120})\\](?!\\()`);

/** Inline Markdown: code, strong, emphasis, strike-through and links (shown as their text). */
export function Inline({ text, q }: { text: string; q: string }): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) break;
    if (m.index) out.push(<Marked key={key++} text={rest.slice(0, m.index)} q={q} />);
    if (m[2] !== undefined) out.push(<code key={key++} className="ai-inline-code"><Marked text={m[2]} q={q} /></code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key++}><Inline text={m[3] ?? m[4]} q={q} /></strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key++}><Inline text={m[5] ?? m[6]} q={q} /></em>);
    else if (m[7] !== undefined) out.push(<s key={key++}><Inline text={m[7]} q={q} /></s>);
    else if (m[10] !== undefined) out.push(<CiteChip key={key++} handle={m[10]} />);
    else out.push(<span key={key++} className="ai-link" title={m[9]}><Inline text={m[8]} q={q} /></span>);
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(<Marked key={key++} text={rest} q={q} />);
  return <>{out}</>;
}

/** What a cell reads as once its inline marks are gone (for the TSV copy and the numeric test). */
export function plainText(s: string): string {
  let out = withoutFlags(s);
  for (let i = 0; i < 4; i++) out = out.replace(new RegExp(INLINE.source, "g"), (...g) => g[2] ?? g[3] ?? g[4] ?? g[5] ?? g[6] ?? g[7] ?? g[8] ?? "");
  return out;
}

/** A number once % and thousands separators are dropped (`isNumericText`). */
export function isNumericText(s: string): boolean {
  const t = s.trim().replace(/%/g, "").replace(/,/g, "");
  return t !== "" && /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf(inity)?|nan)$/i.test(t);
}

/** The table as tab-separated lines: "Copy Table (TSV)". */
export function tableTSV(t: Extract<Block, { kind: "table" }>): string {
  const lines: string[] = [];
  if (t.header.length) lines.push(t.header.map(plainText).join("\t"));
  for (const r of t.rows) lines.push(r.map(plainText).join("\t"));
  return lines.join("\n");
}

/** A column's alignment: the source's, else right when every filled body cell is a number. */
export function columnAlignment(t: Extract<Block, { kind: "table" }>, c: number): Align {
  const given = t.alignments[c];
  if (given && given !== "left") return given;
  const filled = t.rows.map((r) => (c < r.length ? plainText(r[c]) : "")).filter((x) => x.trim() !== "");
  return filled.length && filled.every(isNumericText) ? "right" : "left";
}

/** Lines over which a code well offers "Show all N lines" (`DS.Layout.wellExpandLineCount`). */
export const WELL_EXPAND_LINES = 12;

export type ContextMenuOpener = (e: React.MouseEvent, items: MenuItem[]) => void;

/**
 * The one scrolling code surface: fenced blocks and a tool's input and result. Capped (320 pt, or
 * 220 pt for a tool's) and scrolling both ways until "Show all N lines" lifts the cap.
 */
export function CodeWell({ text, q = "", tool = false, label = w.codeBlock, onCopy, onMenu }: { text: string; q?: string; tool?: boolean; label?: string; onCopy: (text: string) => void; onMenu: ContextMenuOpener }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = text.split("\n").length;
  const long = lineCount > WELL_EXPAND_LINES;
  return (
    <div className="ai-well-wrap">
      <pre
        className="ai-well"
        data-tool={tool || undefined}
        data-expanded={expanded || undefined}
        aria-label={label}
        tabIndex={0}
        onContextMenu={(e) => {
          e.stopPropagation();
          onMenu(e, [{ label: w.copy, run: () => onCopy(text) }]);
        }}
      >
        <Marked text={text} q={q} />
      </pre>
      {long ? (
        <button type="button" className="ai-well-toggle" title={expanded ? w.showLessHelp : w.showAllHelp(lineCount)} onClick={() => setExpanded(!expanded)}>
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={12} />
          {expanded ? w.showLess : w.showAll(lineCount)}
        </button>
      ) : null}
    </div>
  );
}

export function Markdown({ text, q, onCopy, onMenu, citations = null }: { text: string; q: string; onCopy: (text: string) => void; onMenu: ContextMenuOpener; citations?: Citations | null }) {
  const blocks = parseMarkdown(citations ? withFlags(text, citations.check) : text);
  return (
    <CitationsContext.Provider value={citations}>
    <div className="ai-markdown">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "paragraph":
            return <p key={i}><Inline text={b.text} q={q} /></p>;
          case "heading": {
            const level = Math.min(6, Math.max(1, b.level));
            return (
              <div key={i} role="heading" aria-level={level} className="ai-heading" data-level={level}>
                <Inline text={b.text} q={q} />
              </div>
            );
          }
          case "listItem":
            return (
              <div key={i} className="ai-list-item" style={{ ["--ai-depth" as string]: Math.max(0, b.depth - 1) }}>
                <span className="ai-list-marker" aria-hidden>{b.marker}</span>
                <span><Inline text={b.text} q={q} /></span>
              </div>
            );
          case "quote":
            return <blockquote key={i}><Inline text={b.text} q={q} /></blockquote>;
          case "code":
            return <CodeWell key={i} text={b.text} q={q} onCopy={onCopy} onMenu={onMenu} />;
          case "rule":
            return <hr key={i} />;
          case "table": {
            const columns = Math.max(1, b.header.length, ...b.rows.map((r) => r.length));
            const aligns = Array.from({ length: columns }, (_, c) => columnAlignment(b, c));
            return (
              <div
                key={i}
                className="ai-table-wrap"
                onContextMenu={(e) => {
                  e.stopPropagation();
                  onMenu(e, [{ label: w.copyTable, run: () => onCopy(tableTSV(b)) }]);
                }}
              >
                <table className="ai-table" aria-label={w.tableLabel(b.rows.length, columns)}>
                  {b.header.length ? (
                    <thead>
                      <tr>{aligns.map((a, c) => <th key={c} data-align={a}><Inline text={b.header[c] ?? ""} q={q} /></th>)}</tr>
                    </thead>
                  ) : null}
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>{aligns.map((a, c) => <td key={c} data-align={a} data-numeric={isNumericText(plainText(r[c] ?? "")) || undefined}><Inline text={r[c] ?? ""} q={q} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
        }
      })}
    </div>
    </CitationsContext.Provider>
  );
}
