// Entry point of mock.html: the real interface against the simulated backend, in any browser.
// Run `npm run dev:mock` and open http://localhost:1450/mock.html. URL parameters:
//   theme=light|dark          appearance for this page (saved like the Settings choice)
//   contrast=more, motion=reduce, text=0.92|1.12|1.25|1.5   the other Appearance settings
//   reset=1                   forget every saved qnet.* setting first
//   aside=1                   pretend settings.json couldn't be read at launch (shows the notice)
import { mockTauri } from "../test/tauri";
import { APPEARANCE_KEY_FOR_PREVIEW, defaultHandlers } from "./mockShared";

const q = new URLSearchParams(location.search);

if (q.get("reset") === "1") {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("qnet.")) localStorage.removeItem(k);
  } catch {
    // No storage: nothing saved to reset.
  }
}

/** Saves Appearance choices from the URL where theme.ts reads them on load. */
function applyAppearance() {
  const patch: Record<string, string | number> = {};
  const theme = q.get("theme");
  if (theme === "light" || theme === "dark") patch.theme = theme;
  if (q.get("contrast") === "more") patch.contrast = "more";
  if (q.get("motion") === "reduce") patch.motion = "reduce";
  const text = Number(q.get("text"));
  if ([0.92, 1.12, 1.25, 1.5].includes(text)) patch.textScale = text;
  if (!Object.keys(patch).length) return;
  try {
    const a = JSON.parse(localStorage.getItem(APPEARANCE_KEY_FOR_PREVIEW) ?? "{}");
    localStorage.setItem(APPEARANCE_KEY_FOR_PREVIEW, JSON.stringify({ ...a, ...patch }));
  } catch {
    // Storage is off: the theme attribute still applies.
  }
  if (patch.theme) document.documentElement.setAttribute("data-theme", String(patch.theme));
}

applyAppearance();
const setAside = q.get("aside") === "1"
  ? [{ file: "settings.json", path: "~/Library/Application Support/com.nemecj.qnet.dev/settings.json", backup: "~/Library/Application Support/com.nemecj.qnet.dev/settings.json.corrupt-1762790000000", error: "EOF while parsing an object", tsMs: 1762790000000 }]
  : [];
mockTauri(defaultHandlers({ setAside }), { events: true });
// The assistant's scripted model, so "Explain this result" can be tried without a provider.
void import("./mock/aiExplain").then((m) => m.installExplainModel());

// The real entry point, after the backend is in place.
void import("../main");
