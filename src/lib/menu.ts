// The menu bar, from the one command list. `resolveMenu` lays MENU_SPEC (src/lib/menuSpec.ts) over
// the registered commands (titles, enablement, check marks) and the run-time providers (Open
// Recent, the Window menu's tabs), and `startMenu` keeps the native bar (src-tauri/src/menu.rs) in
// step and routes its clicks back here. In a plain browser there is no native bar, so the same
// shortcuts are matched in the page (`installPreviewKeys`).
//
// When the menu is resolved again: whenever the command list changes, and after any state change
// someone reports with `invalidateMenu()` (the workspace store does, on every change), plus after
// focus and pointer events, as 0.90.34's `MenuContext` refreshed on them (ledger MENU-201).
import { listen } from "@tauri-apps/api/event";
import { invoke, inTauri } from "./api";
import { getCommand, getCommands, runCommand, titleOf, unavailableReason, useCommandList } from "./commands";
import { MENU_SPEC, PAIRED_ACCELS, type PredefinedRole, type SpecEntry } from "./menuSpec";
import { useEffect } from "react";

/** One entry of the native menu: src-tauri/src/menu.rs `MenuNode`. */
export type MenuNode =
  | { type: "item"; id: string; label: string; accel?: string; enabled: boolean; checked?: boolean }
  | { type: "submenu"; label: string; items: MenuNode[]; enabled?: boolean; role?: "window" | "help" }
  | { type: "separator" }
  | { type: "header"; label: string }
  | { type: "predefined"; role: PredefinedRole };

/** An item a provider supplies: the same as a command item, with its own click handler. */
export interface DynamicItem {
  id: string;
  label: string;
  accel?: string;
  enabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  run?: () => unknown;
}

const providers = new Map<string, () => DynamicItem[]>();
const dynamicRuns = new Map<string, () => unknown>();

/** Supplies the items of a `{dynamic: name}` slot; returns a function that removes the provider. */
export function registerMenuProvider(name: string, provide: () => DynamicItem[]): () => void {
  providers.set(name, provide);
  invalidateMenu();
  return () => {
    if (providers.get(name) === provide) providers.delete(name);
    invalidateMenu();
  };
}

/** Whether `id` is enabled now: registered, and its `when` allows it. */
function enabledNow(id: string): boolean {
  const c = getCommand(id);
  return !!c && unavailableReason(c) === null;
}

/** The key of a buffer-mode pair goes to whichever item is enabled (ledger MENU-114). */
function accelFor(id: string, accel: string | undefined): string | undefined {
  for (const [a, b] of PAIRED_ACCELS) {
    const key = MENU_SPEC_ACCELS.get(a);
    if (id === a) return enabledNow(a) || !enabledNow(b) ? key : undefined;
    if (id === b) return enabledNow(b) && !enabledNow(a) ? key : undefined;
  }
  return accel;
}

const MENU_SPEC_ACCELS = new Map<string, string>();
(function index(entries: SpecEntry[]) {
  for (const e of entries) {
    if (e === "-") continue;
    if ("id" in e && e.accel) MENU_SPEC_ACCELS.set(e.id, e.accel);
    if ("submenu" in e) index(e.items);
  }
})(MENU_SPEC);

/** The menu as the native side builds it, from the spec, the commands and the providers. */
export function resolveMenu(entries: SpecEntry[] = MENU_SPEC): MenuNode[] {
  dynamicRuns.clear();
  const walk = (list: SpecEntry[]): MenuNode[] => {
    const out: MenuNode[] = [];
    for (const e of list) {
      if (e === "-") out.push({ type: "separator" });
      else if ("header" in e) out.push({ type: "header", label: e.header });
      else if ("predefined" in e) out.push({ type: "predefined", role: e.predefined });
      else if ("submenu" in e) out.push({ type: "submenu", label: e.submenu, items: walk(e.items), ...(e.role ? { role: e.role } : {}) });
      else if ("dynamic" in e) {
        const items = providers.get(e.dynamic)?.() ?? [];
        for (const d of items) {
          if (d.separator) {
            out.push({ type: "separator" });
            continue;
          }
          if (d.run) dynamicRuns.set(d.id, d.run);
          out.push({ type: "item", id: d.id, label: d.label, enabled: d.enabled ?? true, ...(d.accel ? { accel: d.accel } : {}), ...(d.checked !== undefined ? { checked: d.checked } : {}) });
        }
      } else {
        const c = getCommand(e.id);
        let checked: boolean | undefined;
        if (e.check) {
          try {
            checked = !!c?.checked?.();
          } catch {
            checked = false;
          }
        }
        const accel = accelFor(e.id, e.accel);
        out.push({
          type: "item",
          id: e.id,
          label: c?.dynamicTitle ? titleOf(c) : e.label,
          enabled: enabledNow(e.id),
          ...(accel ? { accel } : {}),
          ...(checked !== undefined ? { checked } : {}),
        });
      }
    }
    return out;
  };
  return walk(entries);
}

/** Runs a menu item's action by id: a provider's item, or a command. */
export function runMenuItem(id: string): void {
  const d = dynamicRuns.get(id);
  if (d) {
    void d();
    return;
  }
  void runCommand(id);
}

let pending = 0;
let lastSent = "";
let running = false;

function sync() {
  pending = 0;
  if (!running || !inTauri) return;
  const menu = resolveMenu();
  const json = JSON.stringify(menu);
  if (json === lastSent) return;
  lastSent = json;
  invoke("menu_set", { menu }).catch(() => {
    lastSent = "";
  });
}

/** Asks for the menu to be resolved again soon (coalesced to one frame). */
export function invalidateMenu(): void {
  if (!running || pending) return;
  pending = window.setTimeout(sync, 16);
}

/** Starts keeping the native menu in step and routing its clicks; returns a function that stops. */
export function startMenu(): () => void {
  running = true;
  lastSent = "";
  sync();
  const refresh = () => invalidateMenu();
  const events = ["focusin", "pointerup", "keyup"] as const;
  for (const ev of events) window.addEventListener(ev, refresh, true);
  let alive = true;
  let unlisten: (() => void) | undefined;
  if (inTauri) {
    listen<string>("menu://click", (e) => runMenuItem(e.payload)).then((u) => (alive ? (unlisten = u) : u()), () => {});
  }
  return () => {
    alive = false;
    running = false;
    unlisten?.();
    for (const ev of events) window.removeEventListener(ev, refresh, true);
  };
}

/** Re-resolves the menu whenever the command list changes. */
export function useMenuSync(): void {
  const cmds = useCommandList();
  useEffect(() => invalidateMenu(), [cmds]);
}

// --- Shortcuts in a plain browser, and how they read.

const KEY_GLYPH: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓", Enter: "↩", "=": "=", "-": "−", ",": ",", ".": ".", "[": "[", "]": "]", "`": "`" };

/** "CmdOrCtrl+Shift+T" → "⇧⌘T", in the Mac's modifier order (⌃⌥⇧⌘). */
export function displayAccel(accel: string): string {
  const parts = accel.split("+");
  const key = parts[parts.length - 1] || "+";
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  let out = "";
  if (mods.has("ctrl") || mods.has("control")) out += "⌃";
  if (mods.has("alt") || mods.has("option")) out += "⌥";
  if (mods.has("shift")) out += "⇧";
  if (mods.has("cmdorctrl") || mods.has("cmd") || mods.has("command") || mods.has("super")) out += "⌘";
  return out + (KEY_GLYPH[key] ?? key.toUpperCase());
}

/** The shortcut of a menu command as it reads in the menu ("⇧⌘T"), if it has one now. */
export function shortcutFor(id: string): string | undefined {
  const a = accelFor(id, MENU_SPEC_ACCELS.get(id));
  return a ? displayAccel(a) : undefined;
}

const CODE_FOR: Record<string, string> = {
  "`": "Backquote", ",": "Comma", "/": "Slash", "=": "Equal", "-": "Minus", ".": "Period", "[": "BracketLeft", "]": "BracketRight",
  Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Enter: "Enter",
};

function codeFor(key: string): string {
  if (CODE_FOR[key]) return CODE_FOR[key];
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^[A-Z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return key;
}

/** Does a key press match an accelerator? Compares physical keys, so it works on any layout. */
export function matchesAccel(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, accel: string): boolean {
  const parts = accel.split("+");
  const key = parts[parts.length - 1] || "=";
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const want = {
    meta: mods.some((m) => ["cmdorctrl", "cmd", "command", "super"].includes(m)),
    ctrl: mods.some((m) => ["ctrl", "control"].includes(m)),
    alt: mods.some((m) => ["alt", "option"].includes(m)),
    shift: mods.includes("shift"),
  };
  return e.code === codeFor(key) && e.metaKey === want.meta && e.ctrlKey === want.ctrl && e.altKey === want.alt && e.shiftKey === want.shift;
}

/** Every item of the resolved menu that has a shortcut, with its id. */
function accelItems(nodes: MenuNode[], out: { id: string; accel: string; enabled: boolean }[] = []) {
  for (const n of nodes) {
    if (n.type === "item" && n.accel) out.push({ id: n.id, accel: n.accel, enabled: n.enabled });
    else if (n.type === "submenu") accelItems(n.items, out);
  }
  return out;
}

/** In a plain browser: the menu bar's shortcuts, matched in the page. Returns a function that stops. */
export function installPreviewKeys(): () => void {
  if (inTauri) return () => {};
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || (!e.metaKey && !e.ctrlKey)) return;
    for (const it of accelItems(resolveMenu())) {
      if (!matchesAccel(e, it.accel)) continue;
      e.preventDefault();
      if (it.enabled) runMenuItem(it.id);
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** For tests: every command id registered now that the menu doesn't name (palette-only ones). */
export function paletteOnlyIds(): string[] {
  const named = new Set<string>();
  const walk = (n: MenuNode[]) => n.forEach((x) => (x.type === "item" ? named.add(x.id) : x.type === "submenu" ? walk(x.items) : undefined));
  walk(resolveMenu());
  return getCommands().map((c) => c.id).filter((id) => !named.has(id));
}
