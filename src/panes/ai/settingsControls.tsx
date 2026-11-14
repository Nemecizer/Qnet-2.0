// Settings ▸ AI Assistant's three live controls (0.90.34 SettingsView.swift `AIAssistantPane`:
// `refreshDiscoveredModels`, `flushKey`, `testConnection`; ledger SET-155, SET-160, SET-165). They
// stand alone — each reads the settings it needs and calls the assistant's backend — so the
// Settings pane (src/windows/settings/panes.tsx) mounts them where its P4 placeholders are.
//
// The key differs from 0.90.34 in one way the backend decides: the page never reads a stored key
// back (`aiKeyStatus` answers only whether there is one), so the field starts empty, says whether
// a key is stored, and has a Remove Key button where 0.90.34 had "empty the field".
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plug, RefreshCw } from "lucide-react";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { addStatus } from "../../workspace/store";
import { setSettings } from "../../lib/kv";
import type { AiProvider } from "../../lib/types";
import { baseURLSetting, modelSetting, requiresKey } from "./model";
import { rememberNames } from "./catalog";
import { aiWords as w } from "./words";
import "./ai.css";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A key typed but not yet written: Test Connection and Refresh save it first (`flushKey`). */
let pendingFlush: (() => Promise<boolean>) | null = null;
/** Resolves to whether the typed key (if any) is now stored. */
export const flushPendingKey = (): Promise<boolean> => pendingFlush?.() ?? Promise.resolve(true);

/** The refresh button beside the Model field, with the line it reports under it (SET-155). */
export function AiModelRefresh({ provider }: { provider: AiProvider }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [provider]);
  // An answer for a provider that is no longer the one shown is not reported under the new one.
  const shown = useRef(provider);
  shown.current = provider;
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      if (!(await flushPendingKey())) return;
      const models = await api.aiModels(provider, baseURLSetting(provider));
      rememberNames(models);
      await setSettings({ [`ai.discovered.${provider}`]: models.map((m) => m.id).join(",") });
      if (shown.current === provider && !models.length) setError(w.refreshEmpty(provider === "lmstudio"));
    } catch (e) {
      if (shown.current === provider) setError(w.refreshFailed(reason(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {busy ? (
        <span className="set-icon-btn ai-set-spinner" role="progressbar" aria-label={w.refreshing} />
      ) : (
        <button type="button" className="set-icon-btn" aria-label={w.refresh} title={w.refreshHelp} onClick={() => void refresh()}>
          <Icon icon={RefreshCw} size={14} />
        </button>
      )}
      {error ? <span className="set-status failure" role="status">{error}</span> : null}
    </>
  );
}

/** The API key field with its reveal toggle and Save Key (SET-160, SET-214). */
export function AiKeyField({ provider }: { provider: AiProvider }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [stored, setStored] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef({ key, provider });
  latest.current = { key, provider };

  // One save at a time: leaving the field and pressing Save Key together write the key once.
  const saving = useRef<{ text: string; done: Promise<boolean> } | null>(null);
  const flush = useCallback((): Promise<boolean> => {
    if (saving.current) return saving.current.done;
    const { key: text, provider: p } = latest.current;
    if (!text || !requiresKey(p)) return Promise.resolve(true);
    const done = (async () => {
      try {
        await api.aiKeySet(p, text);
        // Only what is still true is shown: the provider may have changed, or more been typed.
        if (latest.current.provider === p) {
          setStored(true);
          setError("");
          if (latest.current.key === text) {
            latest.current.key = "";
            setKey("");
          }
        }
        return true;
      } catch (e) {
        // The typed key stays in the field, to try again.
        if (latest.current.provider === p) setError(w.keyFailed(reason(e)));
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = { text, done };
    return done;
  }, []);

  // Per provider: whether a key is stored; a pending key is written when the provider changes or
  // the pane goes away.
  useEffect(() => {
    let live = true;
    setKey("");
    setError("");
    void api.aiKeyStatus(provider).then((s) => live && setStored(s), () => live && setStored(false));
    pendingFlush = flush;
    return () => {
      live = false;
      const text = latest.current.key;
      latest.current.key = "";
      // Unless that very text is already being saved. A key that can't be saved here has no field
      // left to say so in: the active tab's Status log is told.
      if (text && saving.current?.text !== text) {
        void api.aiKeySet(provider, text).catch((e) => addStatus(w.keyNotSaved(w.providerDisplay[provider], reason(e)), "error"));
      }
      if (pendingFlush === flush) pendingFlush = null;
    };
  }, [provider, flush]);

  const remove = async () => {
    try {
      await api.aiKeyDelete(provider);
      setStored(false);
      setError("");
    } catch (e) {
      setError(w.keyFailed(reason(e)));
    }
  };

  return (
    <span className="set-text">
      <input
        type={show ? "text" : "password"}
        className="set-field wide mono"
        aria-label={w.keyLabel}
        title={w.keyHelp}
        value={key}
        placeholder={stored ? w.keyStored : w.keyNone}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setKey(e.target.value)}
        onBlur={() => void flush()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void flush();
        }}
      />
      <button type="button" className="set-icon-btn" role="switch" aria-checked={show} aria-label={w.reveal} title={show ? w.concealHelp : w.revealHelp} onClick={() => setShow(!show)}>
        <Icon icon={show ? EyeOff : Eye} size={14} />
      </button>
      <button type="button" className="btn" aria-label={w.saveKeyLabel} title={w.saveKeyHelp} disabled={!key} onClick={() => void flush()}>
        {w.saveKey}
      </button>
      {stored ? (
        <button type="button" className="btn" title={w.removeKeyHelp} onClick={() => void remove()}>
          {w.removeKey}
        </button>
      ) : null}
      {error ? <span className="set-status failure" role="status">{error}</span> : null}
    </span>
  );
}

/** Test Connection and the line it reports (SET-165). */
export function AiTestConnection({ provider }: { provider: AiProvider }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setResult(null), [provider]);
  const shown = useRef(provider);
  shown.current = provider;
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      // A typed key that could not be saved: the key field says why, and no test is made with the old one.
      if (!(await flushPendingKey())) {
        if (shown.current === provider) setResult({ ok: false, message: w.testKeyNotSaved });
        return;
      }
      const answer = await api.aiTest(provider, baseURLSetting(provider), modelSetting(provider));
      if (shown.current === provider) setResult(answer);
    } catch (e) {
      if (shown.current === provider) setResult({ ok: false, message: reason(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <button type="button" className="btn" aria-label={w.testLabel} title={w.testHelp} disabled={testing} onClick={() => void test()}>
        <Icon icon={Plug} size={12} /> {w.test}
      </button>
      {testing ? (
        <span className="set-status info" role="status">{w.contacting(w.providerDisplay[provider])}</span>
      ) : result ? (
        <span className={`set-status ${result.ok ? "success" : "failure"}`} role="status">{result.message}</span>
      ) : null}
    </>
  );
}
