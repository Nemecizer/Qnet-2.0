// Settings ▸ General (0.90.34 SettingsView.swift `GeneralPane`): Tabs, Run Comparison and All
// Settings — Reset All Settings…, Export… and Import… (ledger SET-040…048, SET-050…053,
// FILE-049…053). The file itself is Rust's (src-tauri/src/settings_io.rs); this asks for the
// path and shows the report line, with a "Show Details…" list when more than four were refused.
import { useState } from "react";
import { CircleCheck, CircleX, Download, Info, Upload } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { destructive } from "../../lib/dialogs";
import { dirtyPanes, resetAllPatch } from "./model";
import { displayNames, PANES } from "./registry";
import { Footnote, MenuRow, Row, Section, ToggleRow, num, useSettingsCtx, w } from "./rows";
import { rows, settingsWords } from "./words";
import { UpdatesSettings } from "../../updates/settings";

const g = settingsWords.general;

type Status = { kind: "success" | "info" | "failure"; text: string; refused: { key: string; name: string; reason: string }[] };

/** Refused values listed inline before the report defers to Show Details… (inlineRefusalLimit). */
const INLINE_REFUSALS = 4;

function StatusLabel({ status }: { status: Status }) {
  const icon = status.kind === "success" ? CircleCheck : status.kind === "info" ? Info : CircleX;
  return (
    <span className={`set-status ${status.kind}`} role="status">
      <Icon icon={icon} size={12} />
      {status.text}
    </span>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function GeneralPane() {
  const c = useSettingsCtx();
  const [status, setStatus] = useState<Status | null>(null);
  const [details, setDetails] = useState(false);
  const dirty = dirtyPanes(c.values, c.schema).length;
  const blocking = num(c.values["sim.blocking"], 2);
  const blockingName = rows["sim.blocking"].titles![blocking] ?? rows["sim.blocking"].titles![2];

  const resetAll = async () => {
    if (dirty === 0) return;
    const ok = await destructive({ title: g.confirmTitle, message: g.confirmMessage(dirty), confirmTitle: g.confirmButton, target: c.doc });
    if (!ok) return;
    const refusal = await c.set(resetAllPatch(c.values));
    setStatus(refusal ? { kind: "failure", text: refusal, refused: [] } : { kind: "success", text: g.allReset, refused: [] });
  };

  const exportSettings = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({ title: g.exportTitle, defaultPath: g.exportName(stamp), filters: [{ name: g.jsonFilter, extensions: ["json"] }] });
    if (!path) return;
    try {
      const r = await api.settingsExport(path);
      setStatus({ kind: "success", text: r.message, refused: [] });
    } catch (e) {
      setStatus({ kind: "failure", text: errorText(e), refused: [] });
    }
  };

  const importSettings = async () => {
    const picked = await open({ title: g.importTitle, multiple: false, directory: false, filters: [{ name: g.jsonFilter, extensions: ["json"] }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      const r = await api.settingsImport(path, displayNames());
      setStatus({ kind: r.status, text: r.message, refused: r.rejected });
      setDetails(false);
    } catch (e) {
      setStatus({ kind: "failure", text: errorText(e), refused: [] });
    }
  };

  return (
    <>
      <Section title={settingsWords.sections.tabs} footer={<Footnote>{g.tabsFooter}</Footnote>}>
        <MenuRow id="tabs.restoreBehavior" options={[0, 1, 2]} />
      </Section>
      <Section title={settingsWords.sections.launch}>
        <ToggleRow id="welcome.showAtLaunch" />
      </Section>
      <Section title={settingsWords.sections.runComparison} footer={<Footnote>{g.runCompareFooter}</Footnote>}>
        <ToggleRow id="runCompare.remember" />
        <Row
          id="general.blockingSummary"
          control={
            <span className="set-inline">
              <span className="set-readonly">{blockingName}</span>
              <button type="button" className="btn" title={g.changeTip} aria-label={g.changeLabel} onClick={() => c.openPane("Simulation")}>
                {g.change}
              </button>
            </span>
          }
        />
      </Section>
      <UpdatesSettings />
      <Section title={settingsWords.sections.allSettings} footer={<Footnote>{g.allFooter}</Footnote>}>
        <Row
          id="general.resetAll"
          caption={dirty === 0 ? g.allAtDefaults : g.panesDiffer(dirty, PANES.length)}
          control={
            <button type="button" className="btn" disabled={dirty === 0} title={dirty === 0 ? g.resetAllTipNone : g.resetAllTip} aria-label={g.resetAllLabel} onClick={() => void resetAll()}>
              {g.resetAll}
            </button>
          }
        />
        <Row
          id="general.exportImport"
          caption={w("general.exportImport").caption}
          control={
            <span className="set-inline">
              <button type="button" className="btn" title={g.exportTip} aria-label={g.exportLabel} onClick={() => void exportSettings()}>
                <Icon icon={Upload} size={12} /> {g.export}
              </button>
              <button type="button" className="btn" title={g.importTip} aria-label={g.importLabel} onClick={() => void importSettings()}>
                <Icon icon={Download} size={12} /> {g.import}
              </button>
            </span>
          }
        />
        {status && (
          <div className="set-status-row">
            <StatusLabel status={status} />
            {status.refused.length > INLINE_REFUSALS && (
              <button type="button" className="btn set-small-btn" title={g.showDetailsTip} aria-label={g.showDetailsLabel} aria-expanded={details} onClick={() => setDetails(!details)}>
                {g.showDetails}
              </button>
            )}
          </div>
        )}
        {status && details && (
          <div className="set-details" role="region" aria-label={g.refusedTitle}>
            <div className="set-details-head">
              <strong>{g.refusedTitle}</strong>
              <span className="muted">{g.refusedCount(status.refused.length)}</span>
            </div>
            {status.refused.map((r) => (
              <div key={r.key} className="set-details-item">
                <div>{r.name}</div>
                <div className="mono muted">{`${r.key} — ${r.reason}`}</div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
