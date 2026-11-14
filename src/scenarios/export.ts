// Export Data… for Compare Scenarios: asks where, then writes the CSV through the export path
// every text export uses (`export_save`), and says so in the tab's Status log.
import { editorFor } from "../editor";
import { api } from "../lib/api";
import { chooseSaveTarget } from "../workspace/files/panels";
import { baseName, stem } from "../workspace/files/paths";
import { tabById } from "../workspace/store";

const words = {
  title: "Export Scenario Comparison",
  fileName: (document: string | null) => `${document ?? "Qnet"} Scenarios.csv`,
  filter: "Comma-separated values",
  saved: (name: string) => `Exported the scenario comparison to ${name}.`,
  failed: (name: string, why: string) => `Couldn't export the scenario comparison to ${name}: ${why}`,
};

/** True when written. */
export async function exportCompareCsv(tabId: string, csv: string): Promise<boolean> {
  const tab = tabById(tabId);
  const path = await chooseSaveTarget(words.title, words.fileName(tab?.path ? stem(tab.path) : tab ? tab.title.replace(/\.bnet$/i, "") : null), [{ name: words.filter, extensions: ["csv"] }]);
  if (!path) return false;
  const say = (text: string, severity?: "info" | "error") => {
    if (tabById(tabId)) editorFor(tabId).status(text, severity);
  };
  try {
    say(words.saved(await api.exportSave(path, csv)));
    return true;
  } catch (e) {
    say(words.failed(baseName(path), e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)), "error");
    return false;
  }
}
