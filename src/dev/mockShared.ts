// What mockMain.tsx needs before the app's own modules load: importing theme.ts there would apply
// the saved appearance before the URL's choice is saved, so the key is repeated here (a test keeps
// the two equal) and the handler table comes from mockBackend.ts, which imports nothing of the app's.
export { defaultHandlers } from "./mockBackend";

/** The same key as src/lib/theme.ts `APPEARANCE_KEY`. */
export const APPEARANCE_KEY_FOR_PREVIEW = "qnet.appearance";
