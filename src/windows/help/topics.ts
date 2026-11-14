// The Help topics: docs/help/manifest.json (the sidebar's order, 0.90.34's `HelpTopic` ids, titles,
// window titles, solver captions and Shell labels) and one Markdown file per topic, bundled as text.
// The Keyboard Shortcuts page is the one topic that is not static: its per-menu tables are
// generated from the live menu each time it is read (./shortcuts.ts, ledger KEY-035).
import { Infinity as InfinityIcon, Grid3x3, Lightbulb, ClipboardList, Sparkles, BookOpen, Compass, ChartColumn, type LucideIcon } from "lucide-react";
import manifestJson from "../../../docs/help/manifest.json";
import { parseMarkdown, plainText, type Block, type Generators } from "./markdown";
import { shortcutBlocks } from "./shortcuts";
import { HELP_SECTIONS } from "./words";

export interface HelpTopic {
  /** 0.90.34's `HelpTopic` raw value: "srbmOrthant". */
  id: string;
  /** Sidebar and menu title. */
  title: string;
  section: string;
  file: string;
  keywords: string[];
  kind: "topic" | "method" | "guide";
  /** The solver binary or menu path shown as a caption, where there is one. */
  subtitle?: string;
  /** The full title: the Status divider, the help buttons' tooltips. */
  windowTitle: string;
  /** The run label when printed in the Shell: "help_alg_qna". */
  label: string;
}

interface ManifestEntry {
  id: string;
  title: string;
  section: string;
  file: string;
  keywords?: string[];
  kind?: string;
  subtitle?: string;
  windowTitle?: string;
  label?: string;
}

const snake = (id: string) => id.replace(/[A-Z]+/g, (m) => `_${m.toLowerCase()}`).replace(/[^a-z0-9_]/g, "");

function entry(e: ManifestEntry): HelpTopic {
  return {
    id: e.id,
    title: e.title,
    section: e.section,
    file: e.file,
    keywords: e.keywords ?? [],
    kind: e.kind === "method" || e.kind === "guide" ? e.kind : "topic",
    ...(e.subtitle ? { subtitle: e.subtitle } : {}),
    windowTitle: e.windowTitle ?? e.title,
    label: e.label && /^help_[a-z0-9_]+$/.test(e.label) ? e.label : `help_${snake(e.id)}`,
  };
}

const sources = import.meta.glob("../../../docs/help/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sourceByFile = new Map(Object.entries(sources).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]));

/** Every topic, in the sidebar's order. */
export const TOPICS: HelpTopic[] = (manifestJson as ManifestEntry[]).map(entry);
const byId = new Map(TOPICS.map((t) => [t.id, t]));

/** The topic the window opens on when none was ever chosen: "Start Here" (2.1; 0.90.34 opened on SRBM in an Orthant, HELP-002). */
export const DEFAULT_TOPIC = byId.has("startHere") ? "startHere" : byId.has("srbmOrthant") ? "srbmOrthant" : (TOPICS[0]?.id ?? "");

export const KEYBOARD_SHORTCUTS = "keyboardShortcuts";

export function topic(id: string): HelpTopic | undefined {
  return byId.get(id);
}

/** The sidebar's groups: 2.1's two and 0.90.34's five in order, then any section the manifest adds. */
export function sections(): string[] {
  const extra = TOPICS.map((t) => t.section).filter((s) => !(HELP_SECTIONS as readonly string[]).includes(s));
  return [...HELP_SECTIONS.filter((s) => TOPICS.some((t) => t.section === s)), ...new Set(extra)];
}

export function topicsIn(section: string): HelpTopic[] {
  return TOPICS.filter((t) => t.section === section);
}

/** SF Symbols → lucide, by a fixed table (HELP-004): lightbulb, infinity, square.grid.3x3, list.bullet.clipboard, sparkles. */
const SECTION_ICONS: Record<string, LucideIcon> = {
  "Start Here": Compass,
  Results: ChartColumn,
  Concepts: Lightbulb,
  "Infinite-Buffer Methods": InfinityIcon,
  "Finite-Buffer Methods": Grid3x3,
  Workflows: ClipboardList,
  "AI Providers": Sparkles,
};
export const sectionIcon = (section: string): LucideIcon => SECTION_ICONS[section] ?? BookOpen;

/** Menu tooltip: the full title, then the solver binary in parentheses where there is one (`menuHelp`). */
export function menuHelp(t: HelpTopic): string {
  return t.subtitle ? `${t.windowTitle} (${t.subtitle})` : t.windowTitle;
}

/** The topic's Markdown as written, or null when its file is not in the build. */
export function topicSource(id: string): string | null {
  const t = byId.get(id);
  return t ? (sourceByFile.get(t.file) ?? null) : null;
}

const generators: Generators = { shortcuts: shortcutBlocks };
const cache = new Map<string, Block[]>();

/** The topic as typeset blocks. Parsed once per topic (HELP-018); Keyboard Shortcuts every time. */
export function topicBlocks(id: string): Block[] {
  const live = id === KEYBOARD_SHORTCUTS;
  const hit = live ? undefined : cache.get(id);
  if (hit) return hit;
  const src = topicSource(id);
  let blocks = src === null ? [] : parseMarkdown(src, generators);
  // The page's tables go where the article marks them; an article without the mark gets them last.
  if (live && src !== null && !/<!--\s*generated:\s*shortcuts\s*-->/.test(src)) blocks = [...blocks, ...shortcutBlocks()];
  if (!live) cache.set(id, blocks);
  return blocks;
}

/** The topic as plain text: what the Status and Shell destinations print. */
export function topicText(id: string): string {
  return plainText(topicBlocks(id));
}

/** The text search reads besides the titles: the whole article, lower-cased once. */
const bodies = new Map<string, string>();
export function topicBody(id: string): string {
  if (id === KEYBOARD_SHORTCUTS) return topicBlocks(id).map((b) => b.text).join("\n").toLowerCase();
  let b = bodies.get(id);
  if (b === undefined) {
    b = topicBlocks(id).map((x) => x.text).join("\n").toLowerCase();
    bodies.set(id, b);
  }
  return b;
}

/** Does a topic match the sidebar's query: its title, window title, caption, keywords or text (HELP-006). */
export function topicMatches(t: HelpTopic, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (t.title.toLowerCase().includes(q) || t.windowTitle.toLowerCase().includes(q)) return true;
  if (t.subtitle?.toLowerCase().includes(q)) return true;
  if (t.keywords.some((k) => k.toLowerCase().includes(q))) return true;
  return topicBody(t.id).includes(q);
}
