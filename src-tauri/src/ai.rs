//! The AI assistant's backend (PLAN.md §7 P7, PARITY §13.1, §13.2, §13.7, §6.17): 0.90.34's
//! LLMBackend.swift and LLMStreaming.swift, with the requests leaving from Rust because the page's
//! content policy allows no outside connections.
//!
//! The pane (src/panes/ai/) owns the conversation, the tools (0.90.34's nine and 2.1's explaining
//! ones, src/panes/ai/explain/) and the loop. One `ai_chat` is
//! one request: Rust turns the neutral `ChatRequest` into the provider's wire format (`wire.rs`),
//! streams the answer (`http.rs`), parses it incrementally (`stream.rs`) and sends it back as
//! `AiEvent`s on the command's `Channel`; `done` or `error` is always the last event. API keys
//! stay in the macOS Keychain (`keys.rs`) and never reach the page.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::errors::QnError;
use crate::{kv, settings_schema};

pub mod http;
pub mod keys;
pub mod stream;
pub mod wire;

#[cfg(test)]
mod tests;

// ── The contract (src/lib/types.ts, "The AI assistant") ─────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
    Ollama,
    Lmstudio,
}

impl Provider {
    /// The Keychain account and settings-key suffix (LLMProvider.rawValue).
    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::Ollama => "ollama",
            Provider::Lmstudio => "lmstudio",
        }
    }

    /// LLMProvider.displayName, as the "API key is required for …" sentence names it.
    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic (Claude API)",
            Provider::Openai => "OpenAI",
            Provider::Ollama => "Ollama (local)",
            Provider::Lmstudio => "LM Studio (local)",
        }
    }

    /// LLMProvider.requiresAPIKey.
    pub fn requires_api_key(self) -> bool {
        matches!(self, Provider::Anthropic | Provider::Openai)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The arguments as the model gave them (a JSON object).
    pub input: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// A reply's own output items, kept so the next request of the same conversation can pass them
/// back unchanged (new in 2.1, OpenAI's Responses API only: its reasoning items "must also be
/// passed back with tool call outputs", developers.openai.com/api/docs/guides/function-calling).
/// Replayed only to the provider and model that wrote them; everything else rebuilds the turn
/// from `text` and `toolCalls`. The pane stores it without reading it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub provider: Provider,
    pub model: String,
    pub items: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    User {
        text: String,
    },
    Assistant {
        text: String,
        #[serde(rename = "toolCalls", default)]
        tool_calls: Vec<ToolCall>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replay: Option<Replay>,
    },
    Tool {
        results: Vec<ToolResult>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub input_schema: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: Provider,
    pub model: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub system: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    pub max_tokens: i64,
    /// Sent only to models known to accept it (`wire::accepts_temperature`, new in 2.1).
    pub temperature: f64,
    pub timeout_sec: f64,
    /// `ai.fallback.anthropic` (new in 2.1): if Claude declines, let another Claude model answer.
    /// Applies only where `wire::anthropic_fallback_applies` says it can.
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    End,
    ToolUse,
    MaxTokens,
    Cancelled,
    /// The model (or the provider's safety classifier) declined to answer (new in 2.1).
    Refusal,
    Other,
}

/// One model a provider's server lists (Refresh model list).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// Anthropic's `display_name` ("Claude Opus 5.5"), when the server gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// One request's stream. `Done` or `Error` is always last.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Text {
        delta: String,
    },
    ToolCall {
        call: ToolCall,
    },
    /// The reply's output items, to store on the assistant turn (see `Replay`).
    Replay {
        replay: Replay,
    },
    /// The reply was declined; `done` with stop reason `refusal` follows. Anthropic's
    /// `stop_details` (`category`, `explanation`), or OpenAI's refusal text as the explanation.
    Refused {
        category: Option<String>,
        explanation: Option<String>,
    },
    Done {
        #[serde(rename = "stopReason")]
        stop_reason: StopReason,
    },
    Error {
        message: String,
    },
}

/// Settings ▸ AI ▸ Test Connection's answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TestOutcome {
    pub ok: bool,
    pub message: String,
}

// ── 0.90.34's errors, in its sentences (LLMBackend.swift `LLMError`) ────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum LlmError {
    NotConfigured(String),
    Transport(String),
    Http(u16, String),
    Decoding(String),
    /// A whole reply that declined (Test Connection), in a sentence of its own (new in 2.1).
    Refused(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::NotConfigured(m) => write!(f, "AI backend not configured: {m}"),
            LlmError::Transport(m) => write!(f, "Network error: {m}"),
            LlmError::Http(code, m) => write!(f, "HTTP {code}: {m}"),
            LlmError::Decoding(m) => write!(f, "Response parse error: {m}"),
            LlmError::Refused(m) => write!(f, "{m}"),
        }
    }
}

/// How a request ended when it did not end with an answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Stopped {
    /// Stop (ai_cancel): not an error (AI-025).
    Cancelled,
    Failed(LlmError),
}

impl From<LlmError> for Stopped {
    fn from(e: LlmError) -> Stopped {
        Stopped::Failed(e)
    }
}

// ── State and commands ──────────────────────────────────────────────────────────────────────────

/// A Stop for one request: `cancel` wakes the request's task wherever it is waiting.
#[derive(Default)]
pub struct Cancel {
    flag: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
        // A permit for a task that starts waiting just after this.
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once the request has been cancelled.
    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            self.notify.notified().await;
        }
    }
}

/// The requests in flight (for `ai_cancel`) and where the keys are kept.
pub struct Ai {
    keys: Arc<dyn keys::KeyStore>,
    active: Arc<Mutex<HashMap<String, Arc<Cancel>>>>,
    next: AtomicU64,
}

impl Ai {
    pub fn new(keys: Arc<dyn keys::KeyStore>) -> Ai {
        Ai { keys, active: Arc::default(), next: AtomicU64::new(1) }
    }

    /// The app's: keys in the macOS Keychain.
    pub fn with_keychain() -> Ai {
        Ai::new(Arc::new(keys::Keychain))
    }

    /// Starts one request on the async runtime and answers with its id at once; `emit` gets its events.
    /// `emit` answers whether the event was delivered: once nobody is listening (the page reloaded,
    /// its window closed) the request is stopped rather than streamed to nowhere.
    pub fn start(&self, request: ChatRequest, emit: impl Fn(AiEvent) -> bool + Send + Sync + 'static) -> String {
        let id = format!("ai-{}-{}", self.next.fetch_add(1, Ordering::SeqCst), wire::uuid().to_lowercase());
        let cancel = Arc::new(Cancel::default());
        self.active.lock().unwrap().insert(id.clone(), cancel.clone());
        let (keys, active, task_id) = (self.keys.clone(), self.active.clone(), id.clone());
        let listener = cancel.clone();
        let emit = move |event: AiEvent| {
            if !emit(event) {
                listener.cancel();
            }
        };
        tauri::async_runtime::spawn(async move {
            let last = match chat(keys, &request, &cancel, &emit).await {
                Ok(stop_reason) => AiEvent::Done { stop_reason },
                Err(Stopped::Cancelled) => AiEvent::Done { stop_reason: StopReason::Cancelled },
                Err(Stopped::Failed(e)) => AiEvent::Error { message: e.to_string() },
            };
            active.lock().unwrap().remove(&task_id);
            emit(last);
        });
        id
    }

    /// Stops a request; one that has already ended (or never was) is left alone.
    pub fn cancel(&self, id: &str) {
        if let Some(c) = self.active.lock().unwrap().get(id) {
            c.cancel();
        }
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }
}

/// The key for `provider`, read fresh for each request (AI-018). A Keychain read can wait on a
/// macOS access prompt, so it runs on a blocking thread.
async fn load_key(keys: Arc<dyn keys::KeyStore>, provider: Provider) -> Result<String, LlmError> {
    tauri::async_runtime::spawn_blocking(move || keys.load(provider))
        .await
        .map_err(|e| LlmError::Transport(e.to_string()))?
        .map_err(|e| LlmError::NotConfigured(format!("The Keychain could not be read ({e}).")))
}

async fn chat(keys: Arc<dyn keys::KeyStore>, request: &ChatRequest, cancel: &Cancel, emit: &(impl Fn(AiEvent) + Send + Sync)) -> Result<StopReason, Stopped> {
    let key = load_key(keys, request.provider).await?;
    if cancel.is_cancelled() {
        return Err(Stopped::Cancelled);
    }
    http::run_chat(request, &key, cancel, emit).await
}

/// One assistant request. Answers with the request's id; the stream arrives on `channel`.
#[tauri::command]
pub async fn ai_chat(ai: State<'_, Ai>, request: ChatRequest, channel: Channel<AiEvent>) -> Result<String, QnError> {
    Ok(ai.start(request, move |event| channel.send(event).is_ok()))
}

/// Stop: the request ends with `done`, stop reason `cancelled`.
#[tauri::command]
pub async fn ai_cancel(ai: State<'_, Ai>, id: String) -> Result<(), QnError> {
    ai.cancel(&id);
    Ok(())
}

async fn on_keys<T: Send + 'static>(ai: &Ai, f: impl FnOnce(&dyn keys::KeyStore) -> Result<T, String> + Send + 'static) -> Result<T, QnError> {
    let keys = ai.keys.clone();
    tauri::async_runtime::spawn_blocking(move || f(keys.as_ref()))
        .await
        .map_err(|e| QnError::failed(e.to_string()))?
        .map_err(|e| QnError::failed(format!("The Keychain could not be changed: {e}")))
}

/// Saves the provider's key (delete, then add; an empty key only deletes: SET-214).
#[tauri::command]
pub async fn ai_key_set(ai: State<'_, Ai>, provider: Provider, key: String) -> Result<(), QnError> {
    on_keys(&ai, move |k| k.save(provider, &key)).await
}

/// Whether a key is stored (blank counts as none: AIPaneView `refreshKeyPresence`). The key itself is never returned.
#[tauri::command]
pub async fn ai_key_status(ai: State<'_, Ai>, provider: Provider) -> Result<bool, QnError> {
    on_keys(&ai, move |k| Ok(k.load(provider).map(|v| !swift_trim(&v).is_empty()).unwrap_or(false))).await
}

#[tauri::command]
pub async fn ai_key_delete(ai: State<'_, Ai>, provider: Provider) -> Result<(), QnError> {
    on_keys(&ai, move |k| k.save(provider, "")).await
}

/// Refresh model list: the models the provider's server offers (AI-095, AI-096; every page of
/// Anthropic's list and only OpenAI's text models since 2.1, `wire::parse_models`).
// `base_u_r_l`: Tauri names a command's arguments in camelCase, and this is the spelling whose
// camelCase is the contract's `baseURL` (src/lib/api.ts).
#[tauri::command]
pub async fn ai_models(ai: State<'_, Ai>, provider: Provider, base_u_r_l: String) -> Result<Vec<ModelInfo>, QnError> {
    let key = load_key(ai.keys.clone(), provider).await.map_err(|e| QnError::failed(e.to_string()))?;
    http::discover_models(provider, &base_u_r_l, &key).await.map_err(|e| QnError::failed(e.to_string()))
}

/// Test Connection: one non-streaming "Say the single word: pong" with the live settings (AI-098).
#[tauri::command]
pub async fn ai_test(ai: State<'_, Ai>, stores: State<'_, kv::Stores>, provider: Provider, base_u_r_l: String, model: String) -> Result<TestOutcome, QnError> {
    let settings = settings_schema::with_defaults(&stores.settings.snapshot());
    let request = test_request(provider, base_u_r_l, model, &settings);
    let key = match load_key(ai.keys.clone(), provider).await {
        Ok(k) => k,
        Err(e) => return Ok(TestOutcome { ok: false, message: e.to_string() }),
    };
    Ok(http::test_connection(&request, &key).await)
}

/// Test Connection's request: the page's provider, URL and model with the stored generation settings.
pub fn test_request(provider: Provider, base_url: String, model: String, settings: &Map<String, Value>) -> ChatRequest {
    ChatRequest {
        provider,
        model,
        base_url,
        system: settings.get("ai.systemPrompt").and_then(Value::as_str).unwrap_or("").to_string(),
        messages: vec![Message::User { text: "Say the single word: pong".into() }],
        tools: vec![],
        max_tokens: settings.get("ai.maxTokens").and_then(Value::as_i64).unwrap_or(4096),
        temperature: settings.get("ai.temperature").and_then(Value::as_f64).unwrap_or(0.7),
        timeout_sec: settings.get("ai.timeoutSec").and_then(Value::as_f64).unwrap_or(60.0),
        fallback: settings.get("ai.fallback.anthropic").and_then(Value::as_bool).unwrap_or(true),
    }
}

/// Swift's `trimmingCharacters(in: .whitespaces)`: spaces and tabs (and Unicode spaces), not newlines.
pub fn swift_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() && c != '\n' && c != '\r')
}
