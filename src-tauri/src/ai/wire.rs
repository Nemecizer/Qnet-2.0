//! Each provider's wire format (LLMBackend.swift, LLMStreaming.swift): where a request goes, its
//! headers and its JSON body, built from the neutral `ChatRequest`; and the non-streaming replies
//! (Test Connection, model discovery) read back.
//!
//! 0.90.34 kept the conversation as Anthropic-style blocks: a user message is text, an assistant
//! message is text plus `tool_use` blocks, and tool results travel in a user message. The neutral
//! messages map onto that one for one (`role: "tool"` is the user message of results).
//!
//! 2.1 (ledger AI-201…): the OpenAI provider speaks the Responses API (`POST {base}/responses`);
//! LM Studio keeps Chat Completions exactly as before. Sampling temperature goes only to models
//! known to accept it. Anthropic's `thinking` blocks are never sent back (see `anthropic_body`).

use serde_json::{json, Map, Value};

use super::{swift_trim, ChatRequest, LlmError, Message, ModelInfo, Provider, ToolCall, ToolSpec};

// ── Which model takes what (new in 2.1) ─────────────────────────────────────────────────────────

/// Whether `id` is `prefix` or `prefix-…` (a dated snapshot or a variant of it).
fn is_or_under(id: &str, prefix: &str) -> bool {
    id == prefix || id.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('-'))
}

/// Claude models that still accept a non-default `temperature`. On Claude Fable 5/5.1/5.2, Opus
/// 5.5/5/4.8/4.7, Sonnet 5.5/5 and Haiku 5.5 a non-default `temperature`, `top_p` or `top_k` is a
/// 400 (the model migration guides, platform.claude.com/docs/en/about-claude/models/migration-guide,
/// "sampling parameters removed"); Opus 4.6, Sonnet 4.6, Haiku 4.5 and older still take it. An id
/// not on this list (a new model, a proxy's own name) is sent no temperature: leaving it out is
/// accepted by every model. Each entry also covers its dated snapshots (`claude-opus-4-5-20251101`).
const ANTHROPIC_TEMPERATURE_MODELS: &[&str] = &[
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4-0",
    "claude-sonnet-4-0", "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3",
];

/// OpenAI models that take `temperature`: the non-reasoning GPT-4 families. Reasoning models (the
/// o-series, GPT-5 and GPT-6) are sent none; developers.openai.com/api/docs/guides/reasoning lists
/// effort as their control, and the Responses reference gives temperature without promising it on
/// every model. An unknown id is sent none.
const OPENAI_TEMPERATURE_MODELS: &[&str] = &["gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "chatgpt-4o-latest"];

/// Whether `request` carries `temperature` to its provider. Ollama and LM Studio run local
/// models whose servers take it, as in 0.90.34.
pub fn accepts_temperature(provider: Provider, model: &str) -> bool {
    let id = model.trim();
    match provider {
        Provider::Anthropic => ANTHROPIC_TEMPERATURE_MODELS.iter().any(|p| is_or_under(id, p)),
        Provider::Openai => OPENAI_TEMPERATURE_MODELS.iter().any(|p| is_or_under(id, p)),
        Provider::Ollama | Provider::Lmstudio => true,
    }
}

/// The models whose refusals Anthropic's server can hand to another Claude model
/// (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`; platform.claude.com/docs/en/
/// build-with-claude/refusals-and-fallback). Only on Anthropic's own API: a proxy or another
/// platform may not know the field.
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub fn anthropic_fallback_applies(request: &ChatRequest) -> bool {
    request.fallback && request.base_url.trim().trim_end_matches('/') == "https://api.anthropic.com" && FALLBACK_MODELS.contains(&request.model.trim())
}

/// A request ready to send.
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

/// A random UUID in Swift's `UUID().uuidString` form (upper case), for the tool-call ids 0.90.34
/// makes up when a server sends none (`ollama-<UUID>`, `call-<UUID>`).
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// JSON with every object's keys in sorted order, as `JSONSerialization` writes with `.sortedKeys`
/// (the `arguments` string of an OpenAI tool call).
pub fn sorted_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), sorted_json(&m[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(sorted_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// `<base>` + `path`, the way `URL.append(path:)` joins them; a base that is no http(s) URL is refused.
fn endpoint(base: &str, path: &str) -> Option<String> {
    let joined = format!("{}{}", base.trim().trim_end_matches('/'), path);
    let url = reqwest::Url::parse(&joined).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()).then_some(joined)
}

/// `text` without a `user:password@` before its host: an address shown in an error must not
/// repeat credentials typed into the Base URL.
pub fn without_userinfo(text: &str) -> String {
    let Some((scheme, rest)) = text.split_once("://") else { return text.to_string() };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => text.to_string(),
    }
}

/// LLMClientFactory.make's refusals, in its order (AI-014).
fn check(request: &ChatRequest, key: &str) -> Result<(), LlmError> {
    if swift_trim(&request.model).is_empty() {
        return Err(LlmError::NotConfigured("Model name is empty.".into()));
    }
    if swift_trim(&request.base_url).is_empty() {
        return Err(LlmError::NotConfigured("Base URL is empty.".into()));
    }
    if request.provider.requires_api_key() && swift_trim(key).is_empty() {
        return Err(LlmError::NotConfigured(format!("API key is required for {}.", request.provider.display_name())));
    }
    Ok(())
}

/// The request for one turn. `streaming` is the pane's (`stream: true`, SSE accepted); without it
/// this is 0.90.34's non-streaming `send`, which Test Connection uses.
pub fn prepare(request: &ChatRequest, key: &str, streaming: bool) -> Result<Prepared, LlmError> {
    check(request, key)?;
    let path = match request.provider {
        Provider::Anthropic => "/v1/messages",
        Provider::Openai => "/responses",
        Provider::Lmstudio => "/chat/completions",
        Provider::Ollama => "/api/chat",
    };
    let url = endpoint(&request.base_url, path).ok_or_else(|| LlmError::NotConfigured("Invalid base URL.".into()))?;
    let mut headers = vec![("Content-Type", "application/json".to_string())];
    let body = match request.provider {
        Provider::Anthropic => {
            if streaming {
                headers.push(("Accept", "text/event-stream".into()));
            }
            headers.push(("x-api-key", key.to_string()));
            headers.push(("anthropic-version", "2023-06-01".into()));
            if anthropic_fallback_applies(request) {
                headers.push(("anthropic-beta", FALLBACK_BETA.into()));
            }
            anthropic_body(request, streaming)
        }
        Provider::Openai => {
            if streaming {
                headers.push(("Accept", "text/event-stream".into()));
            }
            headers.push(("Authorization", format!("Bearer {key}")));
            responses_body(request, streaming)
        }
        Provider::Lmstudio => {
            if streaming {
                headers.push(("Accept", "text/event-stream".into()));
            }
            if !key.is_empty() {
                headers.push(("Authorization", format!("Bearer {key}")));
            }
            openai_body(request, streaming)
        }
        Provider::Ollama => ollama_body(request, streaming),
    };
    Ok(Prepared { url, headers, body })
}

fn system_prompt(request: &ChatRequest) -> Option<&str> {
    let s = request.system.trim();
    (!s.is_empty()).then_some(s)
}

// ── Anthropic (Messages API) ────────────────────────────────────────────────────────────────────

/// The Messages API body. What 2.1 leaves out, and why (ledger AI-201…):
///
/// - `thinking`: not sent, so current models run adaptive thinking (always on for Fable 5.x and
///   Opus 5.5; `{type: "disabled"}` and `budget_tokens` are a 400 there). No `tool_choice` either:
///   the default `auto` is accepted everywhere, the forced `any`/`tool` are not.
/// - Thinking blocks are never replayed. Their signatures bind them to the conversation as it was
///   (system prompt, tools and every earlier turn), and the pane rebuilds the system prompt each
///   request (the explaining rules and the facts it adds, src/panes/ai/explain/prompt.ts), so a
///   replayed block could fail with 400 "Invalid `signature` in `thinking` block". Removing every
///   thinking block from the history is allowed; removing some is not. The neutral history holds
///   no thinking at all, so every request is the "all removed" case.
/// - `temperature`: only for the models `accepts_temperature` lists.
fn anthropic_body(request: &ChatRequest, streaming: bool) -> Value {
    let mut messages = Vec::new();
    for m in &request.messages {
        let (role, blocks): (&str, Vec<Value>) = match m {
            Message::User { text } => ("user", vec![json!({"type": "text", "text": text})]),
            Message::Assistant { text, tool_calls, .. } => {
                // 0.90.34's history holds a text block only for a reply that had text.
                let mut blocks = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({"type": "text", "text": text}));
                }
                blocks.extend(tool_calls.iter().map(|c| json!({"type": "tool_use", "id": c.id, "name": c.name, "input": c.input})));
                ("assistant", blocks)
            }
            Message::Tool { results } => (
                "user",
                results
                    .iter()
                    .map(|r| {
                        let mut b = json!({"type": "tool_result", "tool_use_id": r.id, "content": r.content});
                        if r.is_error {
                            b["is_error"] = json!(true);
                        }
                        b
                    })
                    .collect(),
            ),
        };
        if !blocks.is_empty() {
            messages.push(json!({"role": role, "content": blocks}));
        }
    }
    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "messages": messages,
    });
    if accepts_temperature(Provider::Anthropic, &request.model) {
        body["temperature"] = json!(request.temperature);
    }
    if streaming {
        body["stream"] = json!(true);
    }
    if let Some(sys) = system_prompt(request) {
        body["system"] = json!(sys);
    }
    if !request.tools.is_empty() {
        body["tools"] = request.tools.iter().map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.input_schema})).collect();
    }
    if anthropic_fallback_applies(request) {
        // Routed by the refusal's category to a model Anthropic picks; the header goes with it.
        body["fallbacks"] = json!("default");
    }
    body
}

/// The thinking blocks of a Messages body's history, every one of them removed (whole blocks
/// only; a message left with no content goes too). Answers whether anything was removed. The
/// retry after a 400 about a thinking block's signature sends this body (`http::run_chat`).
pub fn strip_thinking(body: &mut Value) -> bool {
    let mut removed = false;
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for m in messages.iter_mut() {
            if let Some(content) = m.get_mut("content").and_then(Value::as_array_mut) {
                let before = content.len();
                content.retain(|b| !matches!(b.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking")));
                removed |= content.len() != before;
            }
        }
        messages.retain(|m| m.get("content").and_then(Value::as_array).is_none_or(|c| !c.is_empty()));
    }
    removed
}

/// Whether a failed Messages request is the one a thinking block's signature causes (400
/// `invalid_request_error`, "Invalid `signature` in `thinking` block…").
pub fn is_thinking_signature_error(code: u16, body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_lowercase();
    code == 400 && text.contains("signature") && text.contains("thinking")
}

// ── OpenAI and LM Studio (Chat Completions), Ollama (native chat) ───────────────────────────────

fn function_tools(tools: &[ToolSpec]) -> Value {
    tools.iter().map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}})).collect()
}

/// `flattenToText`: a message as plain text, for a request sent without tools (AI-013).
fn flatten(m: &Message) -> (&'static str, String) {
    match m {
        Message::User { text } => ("user", text.clone()),
        Message::Assistant { text, tool_calls, .. } => {
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(text.clone());
            }
            parts.extend(tool_calls.iter().map(|c| format!("[assistant requested tool: {} input={}]", c.name, sorted_json(&Value::Object(c.input.clone())))));
            ("assistant", parts.join("\n"))
        }
        Message::Tool { results } => (
            "user",
            results.iter().map(|r| if r.is_error { format!("[tool error: {}]", r.content) } else { format!("[tool result: {}]", r.content) }).collect::<Vec<_>>().join("\n"),
        ),
    }
}

/// `buildFlatMessages`, the same for both clients.
fn flat_messages(request: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(sys) = system_prompt(request) {
        out.push(json!({"role": "system", "content": sys}));
    }
    for m in &request.messages {
        let (role, text) = flatten(m);
        if !text.is_empty() {
            out.push(json!({"role": role, "content": text}));
        }
    }
    out
}

/// `buildStructuredMessages`; `openai` chooses between the two clients' shapes of a tool call and result.
fn structured_messages(request: &ChatRequest, openai: bool) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(sys) = system_prompt(request) {
        out.push(json!({"role": "system", "content": sys}));
    }
    for m in &request.messages {
        match m {
            Message::User { text } => {
                if !text.is_empty() {
                    out.push(json!({"role": "user", "content": text}));
                }
            }
            Message::Assistant { text, tool_calls, .. } => {
                if text.is_empty() && tool_calls.is_empty() {
                    continue;
                }
                let mut msg = Map::new();
                msg.insert("role".into(), json!("assistant"));
                if openai {
                    // `content` is a string, or null beside `tool_calls`; `arguments` is a JSON string.
                    msg.insert("content".into(), if text.is_empty() { Value::Null } else { json!(text) });
                    if !tool_calls.is_empty() {
                        let calls: Vec<Value> = tool_calls
                            .iter()
                            .map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": sorted_json(&Value::Object(c.input.clone()))}}))
                            .collect();
                        msg.insert("tool_calls".into(), calls.into());
                    }
                } else {
                    // Ollama: `arguments` is an object, and nothing carries an id (paired by order).
                    msg.insert("content".into(), json!(text));
                    if !tool_calls.is_empty() {
                        let calls: Vec<Value> = tool_calls.iter().map(|c| json!({"function": {"name": c.name, "arguments": c.input}})).collect();
                        msg.insert("tool_calls".into(), calls.into());
                    }
                }
                out.push(Value::Object(msg));
            }
            Message::Tool { results } => {
                for r in results {
                    out.push(if openai { json!({"role": "tool", "tool_call_id": r.id, "content": r.content}) } else { json!({"role": "tool", "content": r.content}) });
                }
            }
        }
    }
    out
}

// ── OpenAI (Responses API, new in 2.1) ──────────────────────────────────────────────────────────
//
// developers.openai.com/api/reference/resources/responses/methods/create and the function-calling
// and reasoning guides (developers.openai.com/api/docs/guides/function-calling, …/reasoning):
// `instructions` is the system message; `input` holds the conversation as items: messages
// (`role` user or assistant, string content), `function_call` items (`call_id`, `name`,
// `arguments` as a JSON string) and `function_call_output` items (`call_id`, `output`); function
// tools are flat (`type`, `name`, `description`, `parameters`, `strict`); `max_output_tokens`
// (at least 16) replaces `max_tokens`. The Chat Completions endpoint "does not support function
// calling with GPT-6 Astra or GPT-6.1 Sol" (reasoning guide), which is why the move.
//
// Stateless: `store: false` and the whole history every request, as for the other providers;
// no `previous_response_id`, so nothing of the conversation is kept on OpenAI's side for it. A
// reasoning model's reasoning items "must also be passed back with tool call outputs"
// (function-calling guide); in stateless mode they come back with `encrypted_content` (reasoning
// guide), and the reply's output items are replayed unchanged, in order, when the turn is sent
// again to the same model (`Message::Assistant::replay`). A turn with no replay (another
// provider's, another model's, an older one) is rebuilt from its text and calls, function calls
// without an item `id`. `reasoning.effort` is left unset (the model's default; GPT-6 Astra
// rejects `none`). `strict: false`: the tools' schemas have optional fields, which strict mode
// would require.

fn responses_body(request: &ChatRequest, streaming: bool) -> Value {
    let mut input = Vec::new();
    if request.tools.is_empty() {
        // As for Chat Completions (AI-013): without tools the history is plain text.
        for m in &request.messages {
            let (role, text) = flatten(m);
            if !text.is_empty() {
                input.push(json!({"role": role, "content": text}));
            }
        }
    } else {
        for m in &request.messages {
            match m {
                Message::User { text } => {
                    if !text.is_empty() {
                        input.push(json!({"role": "user", "content": text}));
                    }
                }
                Message::Assistant { text, tool_calls, replay } => {
                    if let Some(r) = replay.as_ref().filter(|r| r.provider == Provider::Openai && r.model == request.model && !r.items.is_empty()) {
                        input.extend(r.items.iter().cloned());
                        continue;
                    }
                    if !text.is_empty() {
                        input.push(json!({"role": "assistant", "content": text}));
                    }
                    for c in tool_calls {
                        input.push(json!({"type": "function_call", "call_id": c.id, "name": c.name, "arguments": sorted_json(&Value::Object(c.input.clone()))}));
                    }
                }
                Message::Tool { results } => {
                    for r in results {
                        input.push(json!({"type": "function_call_output", "call_id": r.id, "output": r.content}));
                    }
                }
            }
        }
    }
    let mut body = json!({
        "model": request.model,
        "input": input,
        "max_output_tokens": request.max_tokens.max(16),
        "store": false,
        "stream": streaming,
    });
    if let Some(sys) = system_prompt(request) {
        body["instructions"] = json!(sys);
    }
    if accepts_temperature(Provider::Openai, &request.model) {
        body["temperature"] = json!(request.temperature);
    }
    if !request.tools.is_empty() {
        body["tools"] = request.tools.iter().map(|t| json!({"type": "function", "name": t.name, "description": t.description, "parameters": t.input_schema, "strict": false})).collect();
        body["tool_choice"] = json!("auto");
    }
    body
}

/// Whether a request replays any output items (an OpenAI 400 is then retried once without them).
pub fn replays_items(request: &ChatRequest) -> bool {
    request.provider == Provider::Openai
        && request.messages.iter().any(|m| matches!(m, Message::Assistant { replay: Some(r), .. } if r.provider == Provider::Openai && r.model == request.model && !r.items.is_empty()))
}

/// `request` with every replay dropped: each turn rebuilt from its text and calls.
pub fn without_replay(request: &ChatRequest) -> ChatRequest {
    let mut r = request.clone();
    for m in &mut r.messages {
        if let Message::Assistant { replay, .. } = m {
            *replay = None;
        }
    }
    r
}

// ── LM Studio (Chat Completions, as 0.90.34 sent it to OpenAI too) ──────────────────────────────

fn openai_body(request: &ChatRequest, streaming: bool) -> Value {
    let messages = if request.tools.is_empty() { flat_messages(request) } else { structured_messages(request, true) };
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": request.max_tokens,
        "temperature": request.temperature,
        "stream": streaming,
    });
    if !request.tools.is_empty() {
        body["tools"] = function_tools(&request.tools);
        body["tool_choice"] = json!("auto");
    }
    body
}

fn ollama_body(request: &ChatRequest, streaming: bool) -> Value {
    let messages = if request.tools.is_empty() { flat_messages(request) } else { structured_messages(request, false) };
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "stream": streaming,
        "options": {"temperature": request.temperature, "num_predict": request.max_tokens},
    });
    if !request.tools.is_empty() {
        body["tools"] = function_tools(&request.tools);
    }
    body
}

// ── Non-streaming replies (Test Connection: 0.90.34's `send`) ───────────────────────────────────

/// A complete reply's content.
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Text(String),
    Tool(ToolCall),
}

fn object_of(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// The blocks of a non-streaming reply, with 0.90.34's sentence when there are none (AI-099).
pub fn parse_reply(provider: Provider, body: &[u8]) -> Result<Vec<Block>, LlmError> {
    let obj: Option<Value> = serde_json::from_slice(body).ok();
    let obj = obj.as_ref().and_then(Value::as_object);
    let decoding = |m: &str| LlmError::Decoding(m.to_string());
    let mut out = Vec::new();
    match provider {
        Provider::Anthropic => {
            let content = obj.and_then(|o| o.get("content")).and_then(Value::as_array).ok_or_else(|| decoding("Missing `content` array in Anthropic response."))?;
            // A declined request is HTTP 200 with `stop_reason: "refusal"` (new in 2.1).
            if obj.and_then(|o| o.get("stop_reason")).and_then(Value::as_str) == Some("refusal") {
                let details = obj.and_then(|o| o.get("stop_details"));
                let field = |k: &str| details.and_then(|d| d.get(k)).and_then(Value::as_str).map(str::to_string);
                return Err(LlmError::Refused(refusal_sentence("Claude", field("category").as_deref(), field("explanation").as_deref())));
            }
            // `thinking` (and `fallback`) blocks are skipped: only text and tool calls are read.
            for item in content {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            out.push(Block::Text(t.to_string()));
                        }
                    }
                    Some("tool_use") => {
                        if let (Some(id), Some(name), Some(input)) = (item.get("id").and_then(Value::as_str), item.get("name").and_then(Value::as_str), item.get("input").and_then(Value::as_object)) {
                            out.push(Block::Tool(ToolCall { id: id.into(), name: name.into(), input: input.clone() }));
                        }
                    }
                    _ => {}
                }
            }
            if out.is_empty() {
                return Err(decoding("Anthropic response had no usable content blocks."));
            }
        }
        Provider::Openai => {
            // A Response: `output[]` of `message` items (content `output_text` or `refusal`),
            // `function_call` items and `reasoning` items (skipped).
            let output = obj.and_then(|o| o.get("output")).and_then(Value::as_array).ok_or_else(|| decoding("Missing `output` array in OpenAI response."))?;
            let mut refusal = None;
            for item in output {
                match item.get("type").and_then(Value::as_str) {
                    Some("message") => {
                        for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                            match part.get("type").and_then(Value::as_str) {
                                Some("output_text") => {
                                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                                        out.push(Block::Text(t.to_string()));
                                    }
                                }
                                Some("refusal") => refusal = part.get("refusal").and_then(Value::as_str).map(str::to_string),
                                _ => {}
                            }
                        }
                    }
                    Some("function_call") => {
                        let (Some(id), Some(name)) = (item.get("call_id").and_then(Value::as_str), item.get("name").and_then(Value::as_str)) else { continue };
                        let input = serde_json::from_str::<Value>(item.get("arguments").and_then(Value::as_str).unwrap_or("{}")).ok();
                        out.push(Block::Tool(ToolCall { id: id.into(), name: name.into(), input: object_of(input.as_ref()) }));
                    }
                    _ => {}
                }
            }
            if out.is_empty() {
                if let Some(r) = refusal {
                    return Err(LlmError::Refused(refusal_sentence("The model", None, Some(&r))));
                }
                return Err(decoding("OpenAI response had neither text nor function calls."));
            }
        }
        Provider::Lmstudio => {
            let message = obj
                .and_then(|o| o.get("choices"))
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|c| c.get("message"))
                .and_then(Value::as_object)
                .ok_or_else(|| decoding("Missing `choices[0].message` in response."))?;
            if let Some(t) = message.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                out.push(Block::Text(t.to_string()));
            }
            for tc in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let function = tc.get("function").and_then(Value::as_object);
                let (Some(id), Some(name)) = (tc.get("id").and_then(Value::as_str), function.and_then(|f| f.get("name")).and_then(Value::as_str)) else { continue };
                let args = function.and_then(|f| f.get("arguments")).and_then(Value::as_str).unwrap_or("{}");
                let input = serde_json::from_str::<Value>(args).ok();
                out.push(Block::Tool(ToolCall { id: id.into(), name: name.into(), input: object_of(input.as_ref()) }));
            }
            if out.is_empty() {
                return Err(decoding("OpenAI response had neither `content` nor `tool_calls`."));
            }
        }
        Provider::Ollama => {
            let message = obj.and_then(|o| o.get("message")).and_then(Value::as_object).ok_or_else(|| decoding("Missing `message` in Ollama response."))?;
            if let Some(t) = message.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                out.push(Block::Text(t.to_string()));
            }
            for tc in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let function = tc.get("function").and_then(Value::as_object);
                let Some(name) = function.and_then(|f| f.get("name")).and_then(Value::as_str) else { continue };
                out.push(Block::Tool(ToolCall { id: format!("ollama-{}", uuid()), name: name.into(), input: object_of(function.and_then(|f| f.get("arguments"))) }));
            }
            if out.is_empty() {
                return Err(decoding("Ollama response had neither `content` nor `tool_calls`."));
            }
        }
    }
    Ok(out)
}

/// A declined reply in plain words (new in 2.1; the pane has its own, src/panes/ai/words.ts).
pub fn refusal_sentence(who: &str, category: Option<&str>, explanation: Option<&str>) -> String {
    let mut s = format!("{who} declined to answer this request.");
    match (explanation.map(str::trim).filter(|e| !e.is_empty()), category.map(str::trim).filter(|c| !c.is_empty())) {
        (Some(e), _) => s.push_str(&format!(" {e}")),
        (None, Some(c)) => s.push_str(&format!(" (Category: {c}.)")),
        (None, None) => {}
    }
    s
}

/// Test Connection's sentence for a reply (SettingsView.swift `testConnection`).
pub fn test_sentence(blocks: &[Block]) -> String {
    let text: Vec<&str> = blocks.iter().filter_map(|b| if let Block::Text(t) = b { Some(t.as_str()) } else { None }).collect();
    let joined = text.join(" ");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return "Connected (no text returned).".into();
    }
    if trimmed.chars().count() > 80 {
        format!("Reply: {}…", trimmed.chars().take(80).collect::<String>())
    } else {
        format!("Reply: {trimmed}")
    }
}

/// "HTTP <code>: <body>" for a failed request: the body, cut to 500 characters plus "…" (`ensureOK`).
pub fn http_error(code: u16, body: &[u8]) -> LlmError {
    let snippet = match std::str::from_utf8(body) {
        Ok(s) if s.chars().count() > 500 => format!("{}…", s.chars().take(500).collect::<String>()),
        Ok(s) => s.to_string(),
        Err(_) => "<non-utf8 body>".to_string(),
    };
    LlmError::Http(code, snippet)
}

// ── Model discovery (LLMProvider.discoverModels) ────────────────────────────────────────────────

/// Where a provider lists its models, and the headers that takes.
pub fn models_request(provider: Provider, base_url: &str, key: &str) -> Result<(String, Vec<(&'static str, String)>), LlmError> {
    let base = swift_trim(base_url);
    if base.is_empty() {
        return Err(LlmError::NotConfigured("Base URL is empty.".into()));
    }
    let base = base.trim_matches('/');
    let endpoint = match provider {
        // 0.90.34 always asked https://api.anthropic.com/v1/models; 2.0 asks the Base URL's server (SET-155, D5).
        Provider::Anthropic => format!("{base}/v1/models"),
        Provider::Openai | Provider::Lmstudio => format!("{base}/models"),
        Provider::Ollama => format!("{base}/api/tags"),
    };
    if !reqwest::Url::parse(&endpoint).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some()) {
        return Err(LlmError::NotConfigured(format!("Invalid model-list endpoint: {}", without_userinfo(&endpoint))));
    }
    let mut headers = Vec::new();
    match provider {
        Provider::Anthropic => {
            if swift_trim(key).is_empty() {
                return Err(LlmError::NotConfigured("API key required to list Anthropic models.".into()));
            }
            headers.push(("x-api-key", key.to_string()));
            headers.push(("anthropic-version", "2023-06-01".to_string()));
        }
        Provider::Openai => {
            if swift_trim(key).is_empty() {
                return Err(LlmError::NotConfigured("API key required to list OpenAI models.".into()));
            }
            headers.push(("Authorization", format!("Bearer {key}")));
        }
        Provider::Lmstudio | Provider::Ollama => {}
    }
    Ok((endpoint, headers))
}

/// The address of one page of Anthropic's model list (new in 2.1). `GET /v1/models` is paginated
/// (platform.claude.com/docs/en/api/models/list: `limit` 1…1000, default 20; `after_id`; the reply
/// has `has_more` and `last_id`), and 0.90.34 read only its first page of 20.
pub fn models_page_url(endpoint: &str, after: Option<&str>) -> String {
    let mut url = match reqwest::Url::parse(endpoint) {
        Ok(u) => u,
        Err(_) => return endpoint.to_string(),
    };
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("limit", "1000");
        if let Some(a) = after {
            q.append_pair("after_id", a);
        }
    }
    url.to_string()
}

/// One reply of a model list: its models, and for Anthropic the `after_id` of the next page.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelPage {
    pub models: Vec<ModelInfo>,
    pub next: Option<String>,
}

/// The models in one model-list reply, in the reply's order. OpenAI's are only its text models
/// (`is_openai_text_model`).
pub fn parse_model_page(provider: Provider, body: &[u8]) -> Result<ModelPage, LlmError> {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let obj = parsed.as_ref().and_then(Value::as_object).ok_or_else(|| LlmError::Decoding("Could not parse model-list response.".into()))?;
    let (list, field, missing) = match provider {
        Provider::Ollama => ("models", "name", "Missing `models[]` in /api/tags response."),
        _ => ("data", "id", "Missing `data[]` in model-list response."),
    };
    // `as? [[String: Any]]`: an array whose every element is an object.
    let items = obj.get(list).and_then(Value::as_array).filter(|a| a.iter().all(Value::is_object)).ok_or_else(|| LlmError::Decoding(missing.into()))?;
    let mut models: Vec<ModelInfo> = items
        .iter()
        .filter_map(|m| {
            let id = m.get(field).and_then(Value::as_str)?.to_string();
            let display_name = (provider == Provider::Anthropic).then(|| m.get("display_name").and_then(Value::as_str).map(str::to_string)).flatten();
            Some(ModelInfo { id, display_name })
        })
        .collect();
    if provider == Provider::Openai {
        models.retain(|m| is_openai_text_model(&m.id));
    }
    let next = (provider == Provider::Anthropic && obj.get("has_more").and_then(Value::as_bool) == Some(true))
        .then(|| obj.get("last_id").and_then(Value::as_str).map(str::to_string))
        .flatten();
    Ok(ModelPage { models, next })
}

/// The models of every page, sorted: by id, except OpenAI's current flagships first, in the
/// order the models page gives them (developers.openai.com/api/docs/models).
pub fn sort_models(provider: Provider, mut models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    if provider == Provider::Openai {
        let rank = |id: &str| OPENAI_FLAGSHIPS.iter().position(|f| *f == id).unwrap_or(OPENAI_FLAGSHIPS.len());
        models.sort_by_key(|m| rank(&m.id));
    }
    models
}

/// The ids in one model-list reply, sorted (0.90.34's `discoverModels` answer for one page).
#[cfg(test)]
pub fn parse_models(provider: Provider, body: &[u8]) -> Result<Vec<String>, LlmError> {
    Ok(sort_models(provider, parse_model_page(provider, body)?.models).into_iter().map(|m| m.id).collect())
}

/// OpenAI's flagship models, most capable first (developers.openai.com/api/docs/models, 2026-11).
pub const OPENAI_FLAGSHIPS: &[&str] = &["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"];

/// Whether an id from OpenAI's `GET /models` is a text-generation model the assistant can chat
/// and call tools with. `/models` lists every model the key can use: embeddings, audio, image,
/// moderation, realtime, transcription, speech and search models among them. Kept: ids starting
/// `gpt-`, `chatgpt-` or an o-series name (`o1`, `o3`, `o4-mini`, …). Dropped: any id naming a
/// non-text modality or a specialised product (`embedding`, `audio`, `realtime`, `transcribe`,
/// `tts`, `whisper`, `image`, `dall-e`, `moderation`, `search`, `live`, `computer-use`, `cyber`,
/// `deep-research`), and `-instruct` models, which answer the legacy Completions endpoint only.
pub fn is_openai_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let family = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o') && id[1..].chars().next().is_some_and(|c| c.is_ascii_digit()));
    const NOT_TEXT: &[&str] = &[
        "embedding", "audio", "realtime", "transcribe", "tts", "whisper", "image", "dall-e", "moderation", "search", "live", "computer-use", "cyber", "deep-research",
        "-instruct",
    ];
    family && !NOT_TEXT.iter().any(|w| id.contains(w))
}

/// The snippet of a failed model-list reply: its first 200 bytes when they are text, else nothing.
pub fn models_http_error(code: u16, body: &[u8]) -> LlmError {
    let head = &body[..body.len().min(200)];
    LlmError::Http(code, std::str::from_utf8(head).unwrap_or("").to_string())
}
