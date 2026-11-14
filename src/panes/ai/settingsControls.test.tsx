// Settings ▸ AI Assistant's live controls against the preview backend (ledger SET-155, SET-160, SET-165).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockAi } from "../../dev/mock/ai";
import { getSetting, loadKv } from "../../lib/kv";
import { extendMock, mockTauri } from "../../test/tauri";
import { activeTab } from "../../workspace/store";
import { AiKeyField, AiModelRefresh, AiTestConnection } from "./settingsControls";
import { tick } from "./testing";

beforeEach(async () => {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "lmstudio", "ai.baseURL.lmstudio": "http://127.0.0.1:1234/v1", "ai.model.lmstudio": "qwen" } }));
  await loadKv();
});

describe("Refresh model list (SET-155)", () => {
  it("asks the server at the Base URL and stores the ids for the From Server section", async () => {
    render(<AiModelRefresh provider="lmstudio" />);
    const button = screen.getByRole("button", { name: "Refresh model list" });
    expect(button).toHaveAttribute("title", "Ask the server for its list of available models");
    mockAi.models = { anthropic: [], openai: [], ollama: [], lmstudio: ["a-model", "b-model"] };
    fireEvent.click(button);
    expect(screen.getByRole("progressbar", { name: "Refreshing model list" })).toBeInTheDocument();
    await waitFor(() => expect(getSetting("ai.discovered.lmstudio", "")).toBe("a-model,b-model"));
    expect(mockAi.modelCalls).toEqual([{ provider: "lmstudio", baseURL: "http://127.0.0.1:1234/v1" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh model list" })).toBeInTheDocument());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a failure and the empty-list hint in 0.90.34's words", async () => {
    render(<AiModelRefresh provider="lmstudio" />);
    mockAi.models = "Could not connect to the server.";
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Refresh failed: Could not connect to the server.");
    mockAi.models = { anthropic: [], openai: [], ollama: [], lmstudio: [] };
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Server returned an empty list. Load a model in LM Studio's Local Server tab and refresh again."));
  });
});

describe("API key (SET-160)", () => {
  it("saves on Save Key, on Return and on leaving the field; the page never shows a stored key", async () => {
    render(<AiKeyField provider="anthropic" />);
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    await waitFor(() => expect(field).toHaveAttribute("placeholder", "No key stored"));
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("title", "Secret key for this provider. Saved to the Keychain on Return, on focus loss or with Save Key");
    const save = screen.getByRole("button", { name: "Save API key to Keychain" });
    expect(save).toHaveTextContent("Save Key");
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: "sk-one" } });
    fireEvent.click(screen.getByRole("switch", { name: "Reveal the API key" }));
    expect(field).toHaveAttribute("type", "text");
    fireEvent.click(save);
    await waitFor(() => expect(mockAi.keys.anthropic).toBe("sk-one"));
    await waitFor(() => expect(field.value).toBe(""));
    expect(field).toHaveAttribute("placeholder", "A key is stored in the Keychain");
    fireEvent.change(field, { target: { value: "sk-two" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockAi.keys.anthropic).toBe("sk-two"));
    fireEvent.change(field, { target: { value: "sk-three" } });
    fireEvent.blur(field);
    await waitFor(() => expect(mockAi.keys.anthropic).toBe("sk-three"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Key" }));
    await waitFor(() => expect(mockAi.keys.anthropic).toBeUndefined());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Key" })).toBeNull());
  });

  it("writes a pending key when the pane goes away, and before Test Connection (SET-165)", async () => {
    const view = render(
      <>
        <AiKeyField provider="openai" />
        <AiTestConnection provider="openai" />
      </>,
    );
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-pending" } });
    mockAi.test = { ok: true, message: "Reply: pong" };
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test).toHaveAttribute("title", "Send a one-word prompt to the configured endpoint and show the reply.");
    fireEvent.click(test);
    expect(screen.getByRole("status")).toHaveTextContent("Contacting OpenAI…");
    expect(test).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Reply: pong"));
    expect(mockAi.keys.openai).toBe("sk-pending");
    expect(mockAi.testCalls).toEqual([{ provider: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-6-astra" }]);

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-left" } });
    view.unmount();
    await act(() => tick(0));
    expect(mockAi.keys.openai).toBe("sk-left");
  });
});

describe("Test Connection (SET-165)", () => {
  it("shows the backend's failure sentence", async () => {
    render(<AiTestConnection provider="lmstudio" />);
    mockAi.test = { ok: false, message: "Could not connect to the server." };
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("status")).toHaveTextContent("Contacting LM Studio (local)…");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not connect to the server."));
    expect(screen.getByRole("status")).toHaveClass("failure");
    expect(mockAi.testCalls).toEqual([{ provider: "lmstudio", baseURL: "http://127.0.0.1:1234/v1", model: "qwen" }]);
  });
});

describe("a key the Keychain refuses, and answers that arrive late (the second P7 review)", () => {
  it("keeps the typed key in the field, says why, and makes no test with the old key", async () => {
    extendMock({ ai_key_set: () => Promise.reject({ kind: "io", message: "The keychain is locked." }) });
    render(
      <>
        <AiKeyField provider="openai" />
        <AiTestConnection provider="openai" />
      </>,
    );
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByText("Not tested: the key you typed could not be saved.")).toBeInTheDocument());
    expect(screen.getByText("Could not save the key: The keychain is locked.")).toBeInTheDocument();
    expect(field.value).toBe("sk-typed");
    expect(mockAi.testCalls).toEqual([]);
  });

  it("tells the Status log when a typed key can't be saved as its field goes away", async () => {
    extendMock({ ai_key_set: () => Promise.reject({ kind: "io", message: "The keychain is locked." }) });
    const view = render(<AiKeyField provider="anthropic" />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-lost" } });
    const before = activeTab().log.length;
    view.unmount();
    await act(() => tick(0));
    expect(activeTab().log.slice(before).map((l) => [l.severity, l.text])).toEqual([["error", "The Anthropic (Claude API) API key you typed was not saved: The keychain is locked."]]);
  });

  it("does not show one provider's test result under another", async () => {
    let answer: (v: { ok: boolean; message: string }) => void = () => {};
    extendMock({ ai_test: () => new Promise((r) => (answer = r)) });
    const view = render(<AiTestConnection provider="openai" />);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await act(() => tick(0));
    view.rerender(<AiTestConnection provider="ollama" />);
    await act(async () => {
      answer({ ok: true, message: "Reply: pong" });
      await tick(0);
    });
    expect(screen.queryByText("Reply: pong")).toBeNull();
  });
});
