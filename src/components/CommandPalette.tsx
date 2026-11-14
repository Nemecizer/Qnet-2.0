// The command palette (⇧⌘K), copied from NetMon: every command in the one list (src/lib/commands.ts),
// the menu bar's included, searchable by title, keyword and shortcut. Help articles join it in P7.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Search } from "lucide-react";
import { announce } from "../lib/announce";
import { rankCommands, recentCommandIds, runResolved, titleOf, unavailableReason, useCommandList, type Command, type Ranked } from "../lib/commands";
import { shortcutFor } from "../lib/menu";
import { asideFromPalette, closePalette, usePaletteOpen } from "../lib/overlays";
import "./shell.css";
import { shellWords } from "./words";

/** Order of sections when the palette opens empty. */
const GROUP_ORDER = ["Recent", "File", "Edit", "View", "Network", "Tools", "Run", "Test", "Window", "Help", "Qnet"];
const RECENT_SHOWN = 5;

interface Section {
  name: string;
  rows: Ranked[];
}

/** Builds the sections: Recent first (empty query), then groups in a fixed order or by best match. */
export function paletteSections(cmds: Command[], query: string, recent: string[]): Section[] {
  const ranked = rankCommands(cmds, query, recent);
  const sections = new Map<string, Ranked[]>();
  const add = (name: string, r: Ranked) => {
    let rows = sections.get(name);
    if (!rows) sections.set(name, (rows = []));
    rows.push(r);
  };
  if (!query.trim()) {
    const recentRows = recent.map((id) => ranked.find((r) => r.cmd.id === id)).filter((r): r is Ranked => !!r).slice(0, RECENT_SHOWN);
    for (const r of recentRows) add("Recent", r);
    const shown = new Set(recentRows.map((r) => r.cmd.id));
    for (const r of ranked) if (!shown.has(r.cmd.id)) add(r.cmd.group, r);
    const rank = (g: string) => (GROUP_ORDER.indexOf(g) + 1 || GROUP_ORDER.length + 1);
    return [...sections.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([name, rows]) => ({ name, rows }));
  }
  for (const r of ranked) add(r.cmd.group, r);
  // Sections follow their best row, so the top hit is always first.
  return [...sections.entries()].map(([name, rows]) => ({ name, rows }));
}

export function CommandPalette() {
  if (!usePaletteOpen()) return null;
  return createPortal(<Palette />, document.body);
}

function Palette() {
  const registered = useCommandList();
  const cmds = useMemo(() => registered.filter((c) => !c.menuOnly), [registered]);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  /** Set once a command runs: focus then goes where the command puts it, not back to the opener. */
  const ran = useRef(false);
  const recent = useMemo(() => recentCommandIds(), []);

  const sections = useMemo(() => paletteSections(cmds, query, recent), [cmds, query, recent]);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  useEffect(() => {
    inputRef.current?.focus();
    const back = opener.current as HTMLElement | null;
    return () => {
      // Focusing the opener would raise its window over the one a command just opened.
      if (!ran.current && back?.isConnected) back.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => setHi(0), [query]);
  // Escape closes it from anywhere: focus that wandered out of the field (a click on the scrim's
  // edge, a window behind) still ends the palette, before any window takes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target instanceof Node && e.target.isConnected && (e.target as Element).closest?.(".palette"))) return;
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  useEffect(() => {
    if (query) announce(shellWords.palette.results(flat.length));
  }, [flat.length, query]);

  const run = (r: Ranked | undefined) => {
    if (!r) return;
    const reason = asideFromPalette(() => unavailableReason(r.cmd));
    if (reason) {
      announce(`${titleOf(r.cmd)}: ${reason}`, "assertive");
      return;
    }
    // Close first and run once it's gone, so the window or dialog the command opens comes
    // to the front with focus, and nothing hands focus back to the window behind.
    ran.current = true;
    const back = opener.current as HTMLElement | null;
    closePalette();
    window.setTimeout(() => {
      void runResolved(r.cmd, { remember: true });
      // A command that moved focus nowhere (a pane toggle) gives it back to where it was.
      window.setTimeout(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && back?.isConnected) back.focus?.({ preventScroll: true });
      }, 120);
    }, 0);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setHi((h) => Math.min(flat.length - 1, h + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setHi((h) => Math.min(flat.length - 1, h + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery("");
      else closePalette();
    }
  };

  let row = -1;
  return (
    <div className="palette-scrim" data-shell-overlay onPointerDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={shellWords.palette.label} onKeyDown={onKeyDown}>
        <div className="palette-field">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? `palette-row-${hi}` : undefined}
            aria-label={shellWords.palette.search}
            placeholder={shellWords.palette.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="kbd">{shellWords.palette.close}</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label={shellWords.palette.list} ref={listRef}>
          {flat.length === 0 && <div className="palette-empty">{shellWords.palette.none(query)}</div>}
          {sections.map((s) => (
            <div key={s.name} role="group" aria-label={s.name}>
              <div className="palette-group" aria-hidden>{s.name}</div>
              {s.rows.map((r) => {
                row++;
                const i = row;
                // As it will be once this palette has closed: its own being up dims nothing.
                const reason = asideFromPalette(() => unavailableReason(r.cmd));
                const Icon = r.cmd.icon ?? ChevronRight;
                return (
                  <div
                    key={r.cmd.id}
                    id={`palette-row-${i}`}
                    data-row={i}
                    role="option"
                    aria-selected={i === hi}
                    aria-disabled={reason ? true : undefined}
                    className={`palette-row${i === hi ? " hi" : ""}${reason ? " disabled" : ""}`}
                    onPointerMove={() => i !== hi && setHi(i)}
                    onClick={() => run(r)}
                  >
                    <Icon size={15} className="palette-icon" aria-hidden />
                    <span className="palette-text">
                      <span className="palette-title">{highlight(titleOf(r.cmd), r.hits)}</span>
                      {(reason || r.cmd.subtitle) && <span className="palette-sub">{reason ?? r.cmd.subtitle}</span>}
                    </span>
                    {(r.cmd.shortcut ?? shortcutFor(r.cmd.id)) && <kbd className="kbd">{r.cmd.shortcut ?? shortcutFor(r.cmd.id)}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden>
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> {shellWords.palette.move}</span>
          <span><kbd className="kbd">{shellWords.palette.runKey}</kbd> {shellWords.palette.run}</span>
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, hits: number[]): ReactNode {
  if (!hits.length) return text;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let buf = "";
  let on = false;
  const flush = (k: number) => {
    if (!buf) return;
    out.push(on ? <mark key={k}>{buf}</mark> : buf);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    buf += text[i];
  }
  flush(text.length);
  return out;
}
