// Path pieces as 0.90.34's URL methods gave them (macOS paths, "/" separated).
import type { Tab } from "../store";

/** `lastPathComponent`. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** `deletingLastPathComponent().path`: the folder holding `path`. */
export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** `deletingPathExtension().lastPathComponent`: the name without its last extension. */
export function stem(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 0.90.34 `exportBaseName`: the file's name without extension, or the tab title minus ".bnet". */
export function exportBaseName(tab: Tab): string {
  if (tab.path) return stem(tab.path);
  return tab.title.endsWith(".bnet") ? tab.title.slice(0, -5) : tab.title;
}

/** A panel's starting point: `name` in `folder` when there is one, else the name alone. */
export function inFolder(folder: string | null, name: string): string {
  if (!folder) return name;
  return folder.endsWith("/") ? folder + name : `${folder}/${name}`;
}
