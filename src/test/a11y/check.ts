// A small accessibility checker for rendered DOM (docs/ACCESSIBILITY.md; ledger WF-601). No
// dependency: it reads the tree the way a screen reader's name computation does, closely enough to
// catch what a review misses every time — a control with no name, an id used twice, an ARIA
// reference to nothing, an unlabelled dialog, a picture that is neither named nor hidden, a
// focusable element inside a hidden subtree, a role outside the container it needs, and two live
// regions saying the same thing. It is not a WCAG audit: it cannot see colour, layout or order.
//
// `checkA11y(root)` returns the problems; the sweep (src/test/a11y-sweep.test.tsx) renders each
// major view and expects none. Everything goes through `root.ownerDocument`.

export interface A11yProblem {
  rule: string;
  /** A short, stable description of the element: tag, id, classes, a few attributes. */
  where: string;
  detail: string;
}

const NAMED_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton",
  "combobox", "textbox", "searchbox", "listbox", "tree", "treeitem", "grid", "radiogroup", "tablist", "menu", "menubar", "toolbar", "img", "progressbar",
  "dialog", "alertdialog", "scrollbar", "meter",
]);
/** A role and the container role it must sit in. */
const REQUIRED_PARENT: Record<string, string[]> = {
  tab: ["tablist"],
  option: ["listbox", "group"],
  menuitem: ["menu", "menubar", "group"],
  menuitemcheckbox: ["menu", "menubar", "group"],
  menuitemradio: ["menu", "menubar", "group"],
  treeitem: ["tree", "group"],
  row: ["table", "grid", "treegrid", "rowgroup"],
  gridcell: ["row"],
};
const ID_REFS = ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-errormessage", "aria-details"];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function describe(el: Element): string {
  const attrs = ["role", "type", "data-pane", "data-command", "data-tour-action", "name"]
    .map((a) => (el.hasAttribute(a) ? `[${a}=${el.getAttribute(a)}]` : ""))
    .join("");
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
  const parent = el.parentElement;
  const pcls = parent && typeof parent.className === "string" && parent.className ? ` in .${parent.className.trim().split(/\s+/)[0]}` : "";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}${attrs}${pcls}`;
}

function hiddenFromTree(el: Element | null, root: Element): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (e.getAttribute("aria-hidden") === "true" || e.hasAttribute("hidden") || e.hasAttribute("inert")) return true;
    const style = (e as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
    if (e === root.ownerDocument.documentElement) break;
  }
  return false;
}

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "button": return "button";
    case "a": return el.hasAttribute("href") ? "link" : null;
    case "select": return el.hasAttribute("multiple") ? "listbox" : "combobox";
    case "textarea": return "textbox";
    case "img": return el.getAttribute("alt") === "" ? "presentation" : "img";
    case "dialog": return "dialog";
    case "progress": return "progressbar";
    case "meter": return "meter";
    case "input": {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (["button", "submit", "reset", "image", "file", "color"].includes(t)) return "button";
      return el.hasAttribute("list") ? "combobox" : "textbox";
    }
    default: return null;
  }
}

/** The text a subtree contributes to a name: its text, with nested names and without hidden parts. */
function textOf(node: Node, root: Element, seen: Set<Element>): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return "";
  const style = (el as HTMLElement).style;
  if (style && (style.display === "none" || style.visibility === "hidden")) return "";
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label;
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return el.getAttribute("alt") ?? "";
  if (tag === "svg") return el.querySelector(":scope > title")?.textContent ?? "";
  if (tag === "title" || tag === "desc" || tag === "style" || tag === "script") return "";
  if (seen.has(el)) return "";
  seen.add(el);
  let out = "";
  for (const child of Array.from(el.childNodes)) out += ` ${textOf(child, root, seen)}`;
  return out;
}

/** The accessible name, by the steps that matter here: labelledby, label, the native label, content, title. */
export function accessibleName(el: Element, root: Element = el.ownerDocument.body): string {
  const doc = el.ownerDocument;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((id) => {
      const t = doc.getElementById(id);
      return t ? (t.getAttribute("aria-label") ?? t.textContent ?? "") : "";
    }).join(" ").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label.trim();
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
    const id = el.getAttribute("id");
    const forLabel = id ? Array.from(doc.querySelectorAll("label")).find((l) => l.getAttribute("for") === id) : null;
    const wrapping = el.closest("label");
    const source = forLabel ?? wrapping;
    if (source) {
      const text = textOf(source, root, new Set([el])).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(t) && el.getAttribute("value")) return el.getAttribute("value")!.trim();
      if (t === "image" && el.getAttribute("alt")) return el.getAttribute("alt")!.trim();
    }
    const fallback = el.getAttribute("title") ?? el.getAttribute("placeholder");
    return (fallback ?? "").trim();
  }
  if (tag === "img") return (el.getAttribute("alt") ?? el.getAttribute("title") ?? "").trim();
  if (tag === "svg" || el.namespaceURI === "http://www.w3.org/2000/svg") {
    const t = el.querySelector(":scope > title")?.textContent?.trim();
    if (t) return t;
  }
  const role = roleOf(el);
  const fromContent = role && ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"].includes(role);
  if (fromContent) {
    let out = "";
    const seen = new Set<Element>();
    for (const child of Array.from(el.childNodes)) out += ` ${textOf(child, root, seen)}`;
    const text = out.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return (el.getAttribute("title") ?? "").trim();
}

export interface CheckOptions {
  /** Rules to leave out, by name. */
  skip?: string[];
}

/** Every problem under `root` (and in the overlays beside it when `root` is the body). */
export function checkA11y(root: Element, options: CheckOptions = {}): A11yProblem[] {
  const out: A11yProblem[] = [];
  const skip = new Set(options.skip ?? []);
  const doc = root.ownerDocument;
  const add = (rule: string, el: Element, detail: string) => {
    if (!skip.has(rule)) out.push({ rule, where: describe(el), detail });
  };
  const all = [root, ...Array.from(root.querySelectorAll("*"))];

  // 1. An id is used once in the document.
  const ids = new Map<string, Element[]>();
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    const id = el.getAttribute("id")!;
    if (!id) continue;
    ids.set(id, [...(ids.get(id) ?? []), el]);
  }
  for (const [id, els] of ids) if (els.length > 1 && els.some((e) => root.contains(e))) add("duplicate-id", els[1], `id "${id}" is used ${els.length} times`);

  for (const el of all) {
    const hidden = hiddenFromTree(el, root);

    // 2. ARIA references point at something. (aria-controls may name a collapsed panel that is not rendered.)
    for (const attr of ID_REFS) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      if (attr === "aria-controls" && el.getAttribute("aria-expanded") === "false") continue;
      if (attr === "aria-activedescendant" && v === "") continue;
      const missing = v.split(/\s+/).filter((id) => id && !doc.getElementById(id));
      if (!v.trim()) add("aria-reference", el, `${attr} is empty`);
      else if (missing.length) add("aria-reference", el, `${attr} names "${missing.join(" ")}", which is not in the document`);
    }

    // 3. A positive tabindex reorders the page.
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) > 0) add("tabindex", el, `tabindex=${ti} takes the element out of the reading order`);

    if (hidden) {
      // 4. Nothing focusable hides inside aria-hidden (a keyboard user would land on nothing).
      if (el.matches(FOCUSABLE) && !el.closest("[hidden], [inert]") && !styleHidden(el, root) && el.closest('[aria-hidden="true"]')) {
        add("hidden-focusable", el, "focusable, but inside aria-hidden");
      }
      continue;
    }

    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();

    // 5. Everything a user operates, and every landmark-like widget, has a name.
    if (role && NAMED_ROLES.has(role)) {
      // A native <select>'s options and a <progress> inside a named parent are named by the browser.
      const name = accessibleName(el, root);
      if (!name) {
        if (role === "dialog" || role === "alertdialog") add("dialog-name", el, "a dialog needs aria-labelledby or aria-label");
        else if (role === "img") add("image-name", el, "role=img with no name; hide it with aria-hidden if it is decoration");
        else add("control-name", el, `${role} has no accessible name`);
      }
    }
    if (tag === "img" && !el.hasAttribute("alt") && !el.getAttribute("aria-label") && el.getAttribute("role") !== "presentation") add("image-name", el, "img without alt");
    if (tag === "iframe" && !el.getAttribute("title") && !el.getAttribute("aria-label")) add("control-name", el, "iframe without a title");

    // 6. An SVG is a named picture, a container with a role of its own, or hidden. One left bare is
    //    read as an unnamed group, or its text is read with no context.
    if (tag === "svg" && !el.getAttribute("role") && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.querySelector(":scope > title")) {
      add("svg-hidden", el, "an svg with no role or name: add aria-hidden if it is decoration");
    }

    // 7. Roles that only mean something inside their container.
    if (role && REQUIRED_PARENT[role] && el.hasAttribute("role")) {
      const need = REQUIRED_PARENT[role];
      let ok = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const r = roleOf(p) ?? (p.tagName.toLowerCase() === "table" ? "table" : p.tagName.toLowerCase() === "tr" ? "row" : null);
        if (r && need.includes(r)) { ok = true; break; }
      }
      if (!ok) {
        // aria-owns from elsewhere also satisfies it.
        const id = el.getAttribute("id");
        const owned = id ? Array.from(doc.querySelectorAll("[aria-owns]")).some((o) => o.getAttribute("aria-owns")!.split(/\s+/).includes(id)) : false;
        if (!owned) add("role-parent", el, `role=${role} outside ${need.join(" / ")}`);
      }
    }
    if (role === "radio" && el.hasAttribute("role") && !el.closest('[role="radiogroup"]')) add("role-parent", el, "role=radio outside a radiogroup");

    // 8. State attributes the role requires.
    if (el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "switch" || el.getAttribute("role") === "menuitemcheckbox" || el.getAttribute("role") === "menuitemradio") {
      if (!el.hasAttribute("aria-checked")) add("role-state", el, `role=${role} without aria-checked`);
    }
    if ((el.getAttribute("role") === "slider" || el.getAttribute("role") === "scrollbar") && !el.hasAttribute("aria-valuenow")) add("role-state", el, `role=${role} without aria-valuenow`);
    if (el.getAttribute("role") === "combobox" && !el.hasAttribute("aria-expanded")) add("role-state", el, "role=combobox without aria-expanded");

    // 9. A control inside a control: the inner one cannot be reached by a screen reader.
    if (role && ["button", "link"].includes(role) && (tag === "button" || tag === "a")) {
      const outer = el.parentElement?.closest("button, a[href]");
      if (outer) add("nested-interactive", el, `inside ${describe(outer)}`);
    }

    // 10. A label that labels nothing.
    if (tag === "label") {
      const f = el.getAttribute("for");
      if (f && !doc.getElementById(f)) add("aria-reference", el, `label for="${f}" names nothing`);
    }

    // 11. A table of data has header cells.
    if (tag === "table" && el.getAttribute("role") !== "presentation" && el.querySelector("td") && !el.querySelector("th")) add("table-headers", el, "a data table with no th");
  }

  // 12. Two live regions with the same words announce twice.
  const live = all.filter((el) => !hiddenFromTree(el, root) && (["status", "alert", "log"].includes(el.getAttribute("role") ?? "") || ["polite", "assertive"].includes(el.getAttribute("aria-live") ?? "")));
  const said = new Map<string, Element>();
  for (const el of live) {
    if (live.some((o) => o !== el && o.contains(el))) {
      add("live-nested", el, "a live region inside a live region announces twice");
      continue;
    }
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const first = said.get(text);
    if (first) add("live-duplicate", el, `says the same as ${describe(first)}: “${text.slice(0, 60)}”`);
    else said.set(text, el);
  }

  // 13. The page says what language it is in.
  if (root === doc.body && !doc.documentElement.getAttribute("lang")) add("lang", doc.documentElement, "html has no lang");

  return out;
}

function styleHidden(el: Element, root: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const style = (e as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
    if (e === root) break;
  }
  return false;
}

/** The problems as lines, for a failing test's message. */
export function formatProblems(problems: A11yProblem[]): string {
  return problems.map((p) => `${p.rule}: ${p.where} — ${p.detail}`).join("\n");
}
