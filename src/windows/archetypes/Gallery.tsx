// The archetype gallery (0.90.34 ArchetypeGallerySheet.swift in ArchetypeGalleryPanel.swift; ledger
// GEN-042…051): a movable, resizable, document-modal panel "Insert Archetype" (id
// `archetype-gallery`, the `.wide` band). Left: the tiles under Single Station, Lines and Feedback,
// each with its title, schematic and route; a click highlights, a double click inserts, the arrow
// keys walk the catalogue. Right: Size, Load and Buffer model. Footer: the first blocking problem,
// the summary of what Insert will produce, Cancel (Esc) and Insert (Return).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CountField } from "../../components/CountField";
import { PanelWindow } from "../../lib/panel";
import { PanelForm } from "../../canvas/export/PanelForm";
import { Row, Section } from "../../workspace/files/Sheet";
import { BLUEPRINTS, blueprint, GROUPS, uses, type ArchetypeKind } from "./catalogue";
import {
  closeArchetypeGallery,
  galleryProblem,
  gallerySummary,
  initialForm,
  insertFromGallery,
  insertNote,
  moveHighlight,
  schematicFor,
  useGalleryPanel,
  type GalleryForm,
  type GalleryPanelState,
  type Schematic,
} from "./state";
import { archetypeWords as w } from "./words";
import "./archetypes.css";

/** DSSheetSize.wide: 640 × 624, resizable from 640 × 480. */
export const GALLERY_SIZE: [number, number] = [640, 624];
export const GALLERY_MIN: [number, number] = [640, 480];

/** The tile's picture, drawn as 0.90.34's `ArchetypeThumbnail` drew it, in a 260 × 56 box. */
function Thumbnail({ kind }: { kind: ArchetypeKind }) {
  const [s, setS] = useState<Schematic | null>(null);
  useEffect(() => {
    let alive = true;
    schematicFor(kind).then((x) => alive && setS(x), () => {});
    return () => {
      alive = false;
    };
  }, [kind]);
  const W = 260;
  const H = 56;
  const radius = Math.min(H * 0.11, 8);
  const rect = { x: radius + 2, y: radius * 3, w: W - (radius + 2) * 2, h: H - radius * 4 };
  const place = (u: [number, number] | { x: number; y: number }) => {
    const [x, y] = Array.isArray(u) ? u : [u.x, u.y];
    return [rect.x + x * rect.w, rect.y + y * rect.h] as const;
  };
  return (
    <svg className="qn-arch-thumb" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden data-kind={kind}>
      {s?.edges.map((e, i) => {
        const [ax, ay] = place(e.from);
        const [bx, by] = place(e.to);
        if (e.isLoop) return <circle key={i} className="qn-arch-edge" cx={ax} cy={ay - radius * 1.8} r={radius} />;
        if (e.isBackward) return <path key={i} className="qn-arch-edge" d={`M${ax},${ay} Q${(ax + bx) / 2},${Math.min(ay, by) - rect.h * 0.55} ${bx},${by}`} />;
        return <line key={i} className="qn-arch-edge" x1={ax} y1={ay} x2={bx} y2={by} />;
      })}
      {s?.markers.map((m, i) => {
        const [cx, cy] = place(m);
        const r = radius;
        if (m.kind === "source") return <path key={i} className="qn-arch-node source" d={`M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`} />;
        if (m.kind === "buffer") {
          const b = { x: cx - r * 0.85, y: cy - r * 0.75, w: r * 1.7, h: r * 1.5 };
          return (
            <g key={i}>
              <rect className="qn-arch-fill buffer" x={b.x} y={b.y} width={b.w} height={b.h} />
              <path className="qn-arch-edge ink" d={`M${b.x},${b.y} L${b.x + b.w},${b.y} L${b.x + b.w},${b.y + b.h} L${b.x},${b.y + b.h}`} />
            </g>
          );
        }
        if (m.kind === "station") return <circle key={i} className="qn-arch-node station" cx={cx} cy={cy} r={r} />;
        return <rect key={i} className="qn-arch-node sink" x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2} />;
      })}
    </svg>
  );
}


export function ArchetypeGalleryForm({ state, onCancel, onInsert }: { state: Pick<GalleryPanelState, "canvasNodeCount" | "canvasSourceCount" | "initialInfiniteBuffers">; onCancel: () => void; onInsert: (form: GalleryForm, kind: ArchetypeKind) => unknown }) {
  const [form, setForm] = useState<GalleryForm>(() => initialForm(state.initialInfiniteBuffers));
  const [summary, setSummary] = useState("");
  const uid = useId();
  const galleryRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<GalleryForm>) => setForm((f) => ({ ...f, ...patch }));
  const b = blueprint(form.highlighted);
  const problem = galleryProblem(form);

  useEffect(() => {
    let alive = true;
    gallerySummary(form).then((s) => alive && setSummary(s), () => {});
    return () => {
      alive = false;
    };
  }, [form]);

  // The gallery opens with keyboard focus on its highlighted tile, Tandem Line (`.defaultFocus`).
  useEffect(() => {
    galleryRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus({ preventScroll: true });
  }, []);

  const insert = (kind: ArchetypeKind) => {
    if (galleryProblem({ ...form, highlighted: kind })) return;
    return onInsert(form, kind);
  };

  // Only the gallery column takes the arrow keys, so a number field's arrows still step its value.
  const onGalleryKey = (e: KeyboardEvent) => {
    const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = moveHighlight(form.highlighted, delta);
    set({ highlighted: next });
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-archetype="${next}"]`)?.focus();
  };

  return (
    <PanelForm
      id="archetype-gallery"
      wide
      title={w.windowTitle}
      subtitle={w.subtitle}
      footer={{
        problem,
        summary: summary ? <span aria-label={w.willInsert(summary)}>{summary}</span> : null,
        cancelTitle: w.cancel,
        confirmTitle: w.insert,
        canConfirm: problem === null,
        cancelHelp: w.cancelHelp,
        confirmHelp: w.insertHelp(b.title),
        blockedHelp: w.blockedHelp,
        onCancel,
        onConfirm: () => insert(form.highlighted),
      }}
    >
      <div className="qn-arch-columns">
        <div ref={galleryRef} className="qn-arch-gallery" role="listbox" aria-label={w.windowTitle} aria-activedescendant={`${uid}-${form.highlighted}`} onKeyDown={onGalleryKey}>
          {GROUPS.map((g) => (
            <div key={g} className="qn-arch-group" role="group" aria-label={g}>
              <h3 className="qn-sheet-section-title">{g}</h3>
              {BLUEPRINTS.filter((x) => x.group === g).map((x) => (
                <div
                  key={x.id}
                  id={`${uid}-${x.id}`}
                  className="qn-arch-tile"
                  role="option"
                  tabIndex={x.id === form.highlighted ? 0 : -1}
                  aria-selected={x.id === form.highlighted}
                  aria-label={`${x.title}. ${x.subtitle}`}
                  title={x.subtitle}
                  data-archetype={x.id}
                  data-on={x.id === form.highlighted || undefined}
                  onClick={() => set({ highlighted: x.id })}
                  onDoubleClick={() => void insert(x.id)}
                >
                  <span className="qn-arch-title">{x.title}</span>
                  <Thumbnail kind={x.id} />
                  <span className="qn-arch-route">{x.subtitle}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="qn-arch-knobs">
          <Section title={w.size} footer={b.subtitle}>
            {uses(b, "stations") && (
              <Row label={w.stations} help={w.stationsHelp} htmlFor={`${uid}-stations`}>
                <CountField id={`${uid}-stations`} label={w.stationsLabel} help={w.stationsHelp} value={form.stations} min={1} max={12} decrementLabel={w.decrement(w.stationsLabel)} incrementLabel={w.increment(w.stationsLabel)} onChange={(v) => set({ stations: v })} />
              </Row>
            )}
            <Row label={w.servers} help={w.serversHelp} htmlFor={`${uid}-servers`}>
              <CountField id={`${uid}-servers`} label={w.servers} help={w.serversFieldHelp} value={form.servers} min={1} max={16} decrementLabel={w.decrement(w.servers)} incrementLabel={w.increment(w.servers)} onChange={(v) => set({ servers: v })} />
            </Row>
          </Section>
          <Section title={w.load} footer={w.loadFooter}>
            <Row label={w.lambda} help={w.lambdaHelp} htmlFor={`${uid}-lambda`}>
              <input id={`${uid}-lambda`} className="qn-field qn-field-compact" type="text" aria-label={w.lambdaLabel} placeholder="1.0" value={form.lambda} onChange={(e) => set({ lambda: e.target.value })} />
            </Row>
            <Row label={w.rho} help={w.rhoHelp} htmlFor={`${uid}-rho`}>
              <input id={`${uid}-rho`} className="qn-field qn-field-compact" type="text" aria-label={w.rhoLabel} placeholder="0.90" value={form.rho} onChange={(e) => set({ rho: e.target.value })} />
            </Row>
            {uses(b, "feedbackProbability") && (
              <Row label={w.feedback} help={w.feedbackHelp} htmlFor={`${uid}-feedback`}>
                <input id={`${uid}-feedback`} className="qn-field qn-field-compact" type="text" aria-label={w.feedbackLabel} placeholder="0.30" value={form.feedback} onChange={(e) => set({ feedback: e.target.value })} />
              </Row>
            )}
          </Section>
          <Section title={w.bufferModel} footer={insertNote(form, state)}>
            <Row label={w.buffers} help={w.buffersHelp} htmlFor={`${uid}-buffers`}>
              <select id={`${uid}-buffers`} aria-label={w.buffers} value={form.infiniteBuffers ? "infinite" : "finite"} onChange={(e) => set({ infiniteBuffers: e.target.value === "infinite" })}>
                <option value="infinite">{w.infinite}</option>
                <option value="finite">{w.finite}</option>
              </select>
            </Row>
            {!form.infiniteBuffers && (
              <Row label={w.capacity} help={w.capacityHelp} htmlFor={`${uid}-capacity`}>
                <CountField id={`${uid}-capacity`} label={w.capacityLabel} help={w.capacityHelp} value={form.capacity} min={1} max={500} decrementLabel={w.decrement(w.capacityLabel)} incrementLabel={w.increment(w.capacityLabel)} onChange={(v) => set({ capacity: v })} />
              </Row>
            )}
          </Section>
        </div>
      </div>
    </PanelForm>
  );
}

function GalleryPanel({ state }: { state: GalleryPanelState }) {
  return (
    <PanelWindow
      id="archetype-gallery"
      title={w.windowTitle}
      size={GALLERY_SIZE}
      minSize={GALLERY_MIN}
      modality="document"
      escapeCloses={false}
      onClose={closeArchetypeGallery}
    >
      <ArchetypeGalleryForm state={state} onCancel={closeArchetypeGallery} onInsert={(form, kind) => insertFromGallery(state.tabId, form, kind)} />
    </PanelWindow>
  );
}

/** Mount once (App.tsx): the gallery while it is open. */
export function ArchetypeGalleryHost() {
  const state = useGalleryPanel();
  return state ? <GalleryPanel key={state.seq} state={state} /> : null;
}
