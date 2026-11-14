// The "Station Picture" panel (0.90.34 PicturePickerSheet.swift, ledger INS-025…027, INS-129,
// INS-130): a grid of the station pictures in 0.90.34's sections, one highlighted provisionally.
// Choose (Return) or a double-click writes the inspector's draft and closes; Cancel (Esc) keeps the
// current picture; arrows move the highlight (←/→ by one, ↑/↓ by a row of four, clamped).
import { useEffect, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { Icon } from "../../components/Icon";
import { PanelWindow, type PanelModality } from "../../lib/panel";
import { STATION_PICTURES, stationPicture, type StationPicture } from "../../editor/pictures";
import { PicturePreview } from "./fields";
import { panelWords as w } from "./words";

export const PICTURE_PANEL_ID = "station-picture";
const COLUMNS = 4;
const GROUPS: StationPicture["group"][] = ["None", "People", "Manufacturing", "Service", "Logistics"];
/** The tiles in the order the arrows walk them. */
const FLAT = GROUPS.flatMap((g) => STATION_PICTURES.filter((p) => p.group === g));

/** The picker's body, without its window (the tests and the panel share it). */
export function PicturePicker({ current, onChoose, onCancel }: { current: string; onChoose: (sf: string) => void; onCancel: () => void }) {
  const [highlighted, setHighlighted] = useState(stationPicture(current).sf);
  const tiles = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    tiles.current.get(highlighted)?.focus();
  }, [highlighted]);
  const move = (delta: number) => {
    const i = FLAT.findIndex((p) => p.sf === highlighted);
    const j = i < 0 ? 0 : Math.min(Math.max(i + delta, 0), FLAT.length - 1);
    setHighlighted(FLAT[j].sf);
  };
  const h = stationPicture(highlighted);
  return (
    <div
      className="panel-form picture-picker"
      onKeyDown={(e) => {
        const key: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS };
        if (e.key in key) {
          e.preventDefault();
          move(key[e.key]);
        } else if (e.key === "Enter") {
          e.preventDefault();
          onChoose(highlighted);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <header className="panel-header">
        <PicturePreview sf={highlighted} size={44} />
        <div>
          <h1 className="panel-title">{w.pictureTitle}</h1>
          <p className="panel-subtitle">{w.pictureSubtitle}</p>
        </div>
      </header>
      <div className="panel-content picture-grid-scroll">
        {GROUPS.map((g) => (
          <section key={g} className="picture-section" aria-label={w.pictureSections[g]}>
            <h2>{w.pictureSections[g]}</h2>
            <div className="picture-grid" role="listbox" aria-label={w.pictureSections[g]}>
              {STATION_PICTURES.filter((p) => p.group === g).map((p) => {
                const isCurrent = p.sf === stationPicture(current).sf;
                return (
                  <div
                    key={p.sf}
                    ref={(el) => {
                      if (el) tiles.current.set(p.sf, el);
                      else tiles.current.delete(p.sf);
                    }}
                    role="option"
                    tabIndex={p.sf === highlighted ? 0 : -1}
                    aria-selected={p.sf === highlighted}
                    aria-label={isCurrent ? w.currentPicture(p.displayName) : p.displayName}
                    title={p.displayName}
                    className={`picture-tile${p.sf === highlighted ? " is-highlighted" : ""}`}
                    onClick={() => setHighlighted(p.sf)}
                    onDoubleClick={() => onChoose(p.sf)}
                    onFocus={() => setHighlighted(p.sf)}
                  >
                    <PicturePreview sf={p.sf} size={56} selected={p.sf === highlighted} />
                    <span className="picture-name">{p.displayName}</span>
                    {isCurrent ? (
                      <span className="picture-current">
                        <Icon icon={CircleCheck} size={12} />
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <footer className="panel-footer">
        <span className="panel-footer-note" aria-label={w.highlighted(h.displayName)}>
          {h.displayName}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" title={w.pictureCancelHelp} onClick={onCancel}>
          {w.cancel}
        </button>
        <button type="button" className="btn primary" title={w.pictureChooseHelp(h.displayName)} onClick={() => onChoose(highlighted)}>
          {w.choose}
        </button>
      </footer>
    </div>
  );
}

/** The picker in its panel: document-modal from the pane, app-modal from the Node Parameters panel. */
export function PicturePickerPanel({ current, modality, onChoose, onClose }: { current: string; modality: PanelModality; onChoose: (sf: string) => void; onClose: () => void }) {
  return (
    <PanelWindow id={PICTURE_PANEL_ID} title={w.pictureTitle} band="wide" modality={modality} escapeCloses={false} onClose={onClose}>
      <PicturePicker
        current={current}
        onCancel={onClose}
        onChoose={(sf) => {
          onChoose(sf);
          onClose();
        }}
      />
    </PanelWindow>
  );
}
