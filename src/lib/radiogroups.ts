// The keyboard of every segmented control (ledger WF-609; docs/ACCESSIBILITY.md). The app's
// segmented controls are `role="radiogroup"` rows of `role="radio"` buttons (the Results views,
// a view's modes, the Status filter, the Inspector's pickers…). The ARIA pattern for that role is
// one Tab stop and arrow keys, and a screen reader tells its user so; each control used to be a
// row of plain buttons instead. One delegated listener per document gives all of them the pattern
// without touching any of them:
//   ← ↑ / → ↓   the previous / next enabled choice, wrapping, chosen as it is reached
//   Home / End   the first / last
//   Tab          leaves the group (the other choices are skipped), and comes back in at the chosen one
// Pointer behaviour is unchanged. A group that handles a key itself (preventDefault) is left alone.

const GROUP = '[role="radiogroup"]';
const RADIO = '[role="radio"]';

function radiosOf(group: Element): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(RADIO)].filter((r) => r.closest(GROUP) === group && !(r as HTMLButtonElement).disabled && r.getAttribute("aria-disabled") !== "true");
}

/** Installs the pattern on `doc`. Returns a function that removes it. */
export function installRadioGroups(doc: Document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as Element | null;
    const radio = target?.closest?.<HTMLElement>(RADIO);
    const group = radio?.closest(GROUP);
    if (!radio || !group || radio !== target) return;
    const radios = radiosOf(group);
    const at = radios.indexOf(radio);
    if (at < 0) return;

    if (e.key === "Tab") {
      // The rest of the group is out of the Tab order for this one key press.
      const others = radios.filter((r) => r !== radio && r.tabIndex >= 0);
      const before = others.map((r) => r.getAttribute("tabindex"));
      others.forEach((r) => r.setAttribute("tabindex", "-1"));
      const view = doc.defaultView;
      const restore = () => others.forEach((r, i) => (before[i] === null ? r.removeAttribute("tabindex") : r.setAttribute("tabindex", before[i]!)));
      if (view) view.setTimeout(restore, 0);
      else restore();
      return;
    }

    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % radios.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + radios.length) % radios.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = radios.length - 1;
    if (next === null || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const to = radios[next];
    if (to === radio) return;
    to.focus();
    if (to.getAttribute("aria-checked") !== "true") to.click();
  };

  // Tab into a group lands on the chosen radio, wherever in the row it is.
  const onFocusIn = (e: FocusEvent) => {
    const radio = (e.target as Element | null)?.closest?.<HTMLElement>(RADIO);
    const group = radio?.closest(GROUP);
    if (!radio || !group || radio !== e.target) return;
    const from = e.relatedTarget as Node | null;
    if (!from || group.contains(from)) return;
    if (doc.documentElement.dataset.modality === "pointer") return;
    if (radio.getAttribute("aria-checked") === "true") return;
    const chosen = radiosOf(group).find((r) => r.getAttribute("aria-checked") === "true");
    if (chosen && chosen !== radio) chosen.focus();
  };

  doc.addEventListener("keydown", onKey);
  doc.addEventListener("focusin", onFocusIn);
  return () => {
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("focusin", onFocusIn);
  };
}
