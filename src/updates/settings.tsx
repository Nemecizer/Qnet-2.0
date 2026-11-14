// Settings ▸ General ▸ Updates. In a copy built without an update address (every build until the
// owner switches updates on, docs/UPDATES.md) the switch is dimmed and the section says that this
// copy does not check; otherwise it holds "Check for updates automatically" and a Check button.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStateValue } from "../lib/kv";
import { Footnote, Row, Section, ToggleRow } from "../windows/settings/rows";
import { settingsWords } from "../windows/settings/words";
import { LAST_CHECK_KEY, updateFlow } from "./index";
import type { UpdateStatus } from "./model";
import { updateWords } from "./words";

const s = updateWords.settings;

export function UpdatesSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const last = useStateValue<unknown>(LAST_CHECK_KEY, 0);
  useEffect(() => {
    let alive = true;
    api.updateStatus().then((v) => alive && setStatus(v), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const on = status?.configured === true;
  const lastText = typeof last === "number" && last > 0 ? new Date(last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <Section title={settingsWords.sections.updates} footer={<Footnote>{on ? s.footerOn : s.footerOff}</Footnote>}>
      <ToggleRow id="updates.auto" disabled={!on} />
      {on && (
        <Row
          id="updates.check"
          words={{ label: s.checkLabel }}
          caption={s.checkCaption(status.currentVersion, lastText)}
          control={
            <button type="button" className="btn" title={s.checkTip} onClick={() => void updateFlow().checkNow()}>
              {s.checkButton}
            </button>
          }
        />
      )}
    </Section>
  );
}
