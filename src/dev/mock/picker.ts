// The browser preview's Open panel for one file: a list of the preview's own files to click,
// instead of the browser's prompt (which asked for a typed path, and which an embedded preview
// may not show at all — File ▸ Open Example… then did nothing). Preview only: the app uses the
// system's panel. Plain DOM, so it needs nothing from the interface it stands in for.

export interface PickRequest {
  title: string;
  /** The folder the panel starts in; its files are listed first. */
  folder?: string;
  /** Every path the preview can read. */
  paths: string[];
}

const baseName = (p: string) => p.split("/").pop() ?? p;

/** Shows the list in `doc`; resolves to the chosen path, or null on Cancel or Escape. */
export function pickPath(doc: Document, req: PickRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const folder = req.folder?.replace(/\/$/, "");
    const inFolder = (p: string) => folder !== undefined && p.startsWith(`${folder}/`);
    const paths = [...req.paths].sort((a, b) => Number(inFolder(b)) - Number(inFolder(a)) || (a < b ? -1 : a > b ? 1 : 0));
    const returnTo = doc.activeElement;

    const scrim = doc.createElement("div");
    scrim.className = "mock-picker-scrim";
    scrim.style.cssText = "position:fixed;inset:0;z-index:var(--z-dialog,40000);display:grid;place-items:center;background:var(--overlay)";
    const panel = doc.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", req.title);
    panel.style.cssText =
      "display:flex;flex-direction:column;gap:var(--sp-4);width:min(460px,90vw);max-height:70vh;padding:var(--sp-6);border-radius:var(--r-lg);background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop)";
    const heading = doc.createElement("div");
    heading.textContent = req.title;
    heading.style.cssText = "font-weight:var(--fw-semibold);font-size:var(--fs-md)";
    const note = doc.createElement("div");
    note.textContent = "Browser preview: these are the files it can read.";
    note.style.cssText = "color:var(--muted);font-size:var(--fs-sm)";
    const list = doc.createElement("div");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", req.title);
    list.style.cssText = "overflow:auto;border:1px solid var(--hairline);border-radius:var(--r-md);min-height:80px";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.style.alignSelf = "flex-end";

    const done = (path: string | null) => {
      doc.removeEventListener("keydown", onKey, true);
      scrim.remove();
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
      resolve(path);
    };
    const options: HTMLButtonElement[] = paths.map((p) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", "false");
      b.dataset.path = p;
      b.title = p;
      b.textContent = baseName(p);
      b.style.cssText = "display:block;width:100%;padding:var(--sp-3) var(--sp-5);border:0;background:transparent;color:inherit;text-align:left;font:inherit";
      b.addEventListener("click", () => done(p));
      b.addEventListener("focus", () => (b.style.background = "var(--sel)"));
      b.addEventListener("blur", () => (b.style.background = "transparent"));
      list.append(b);
      return b;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!options.length) return;
        e.preventDefault();
        const at = options.indexOf(doc.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? Math.min(options.length - 1, at + 1) : Math.max(0, at - 1);
        options[next].focus();
      }
    };
    doc.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done(null);
    });
    panel.append(heading, note, list, cancel);
    scrim.append(panel);
    doc.body.append(scrim);
    (options[0] ?? cancel).focus();
  });
}
