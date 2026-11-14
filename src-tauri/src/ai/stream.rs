//! The streamed answers, parsed as they arrive (LLMStreaming.swift): Anthropic's and OpenAI's
//! server-sent events and Ollama's newline-delimited JSON, each turned into `AiEvent`s.
//!
//! Nothing here does I/O. `Lines` cuts the byte stream into lines wherever the chunks happen to
//! fall (mid-line, mid-character); a `Parser` takes one line at a time, gives text deltas at once,
//! and at the end of the stream gives the complete tool calls (0.90.34 returned a reply's blocks
//! only when the stream had ended well, so a failed or stopped stream yields no tool call) and
//! the stop reason. 0.90.34 never read stop reasons; 2.0 does, so the pane can say when a reply
//! stopped at the max-tokens limit (AI-026, D5).

//!
//! 2.1: Anthropic `thinking` blocks (and their `thinking_delta` / `signature_delta`) are read past,
//! never shown and never kept; a `fallback` block (another Claude model took over after a
//! refusal) drops the tool calls begun before it, as the refusals guide says to; a `refusal` stop
//! gives a `refused` event. OpenAI is read as the Responses API's events (`responses`).

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use super::wire::uuid;
use super::{AiEvent, LlmError, Provider, Replay, StopReason, ToolCall};

pub const MAX_LINE_BYTES: usize = 8 << 20;

/// Cuts a byte stream into lines (`\n` or `\r\n`), whatever the chunk boundaries.
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
}

impl Lines {
    /// The lines completed by `chunk`. Bytes are decoded only once their line is whole, so a
    /// character split across two chunks arrives intact.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(i) = self.pending[start..].iter().position(|&b| b == b'\n') {
            out.push(decode(&self.pending[start..start + i]));
            start += i + 1;
        }
        self.pending.drain(..start);
        out
    }

    /// Whether the unfinished line has outgrown anything a provider sends (8 MB): a server that
    /// never ends a line must not fill memory.
    pub fn overlong(&self) -> bool {
        self.pending.len() > MAX_LINE_BYTES
    }

    /// The unterminated last line, if the stream ended with one.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.pending);
        (!rest.is_empty()).then(|| decode(&rest))
    }
}

fn decode(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    String::from_utf8_lossy(line).into_owned()
}

/// A tool call arriving in fragments (`ToolAccumulator`).
#[derive(Default)]
struct ToolFragments {
    id: String,
    name: String,
    arguments: String,
}

impl ToolFragments {
    /// The call; arguments that are not a JSON object become `{}`, as in 0.90.34.
    fn call(self) -> ToolCall {
        let input = serde_json::from_str::<Value>(&self.arguments).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        ToolCall { id: self.id, name: self.name, input }
    }
}

/// Whether the reader should go on after a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    More,
    /// The server said the answer is complete (`message_stop`, `[DONE]`, `done: true`).
    Ended,
}

pub struct Parser {
    provider: Provider,
    /// A non-empty text delta has been given.
    text: bool,
    /// Anthropic: block indices in start order. OpenAI: unused.
    order: Vec<i64>,
    fragments: HashMap<i64, ToolFragments>,
    /// Ollama: calls arrive whole.
    calls: Vec<ToolCall>,
    /// The provider's own word for why it stopped.
    reason: Option<String>,
    /// The model asked for (an OpenAI reply's replay is tagged with it).
    model: String,
    /// A refusal's category and explanation (Anthropic `stop_details`; OpenAI's refusal text).
    category: Option<String>,
    explanation: Option<String>,
    /// OpenAI: the reply's finished output items by `output_index`, to replay.
    items: BTreeMap<i64, Value>,
}

fn data_payload(line: &str) -> Option<&str> {
    // `.whitespaces`: spaces and tabs.
    line.strip_prefix("data:").map(|p| p.trim_matches(|c| c == ' ' || c == '\t'))
}

fn json_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

impl Parser {
    #[cfg(test)]
    pub fn new(provider: Provider) -> Parser {
        Parser::for_model(provider, "")
    }

    pub fn for_model(provider: Provider, model: &str) -> Parser {
        Parser {
            provider,
            text: false,
            order: Vec::new(),
            fragments: HashMap::new(),
            calls: Vec::new(),
            reason: None,
            model: model.to_string(),
            category: None,
            explanation: None,
            items: BTreeMap::new(),
        }
    }

    fn give_text(&mut self, t: &str, out: &mut Vec<AiEvent>) {
        if !t.is_empty() {
            self.text = true;
            out.push(AiEvent::Text { delta: t.to_string() });
        }
    }

    /// One line of the stream. Lines that are not this format's are skipped, as 0.90.34 skips them.
    pub fn line(&mut self, line: &str, out: &mut Vec<AiEvent>) -> Result<Next, LlmError> {
        match self.provider {
            Provider::Anthropic => self.anthropic(line, out),
            Provider::Openai => self.responses(line, out),
            Provider::Lmstudio => Ok(self.openai(line, out)),
            Provider::Ollama => self.ollama(line, out),
        }
    }

    fn anthropic(&mut self, line: &str, out: &mut Vec<AiEvent>) -> Result<Next, LlmError> {
        let Some(obj) = data_payload(line).and_then(json_object) else { return Ok(Next::More) };
        match obj.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let index = obj.get("index").and_then(Value::as_i64).unwrap_or(self.order.len() as i64);
                self.order.push(index);
                if let Some(block) = obj.get("content_block").and_then(Value::as_object) {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_use") => {
                            let id = block.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(uuid);
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                            self.fragments.insert(index, ToolFragments { id, name, arguments: String::new() });
                        }
                        // Thinking (often empty text, with a signature): not shown, not kept.
                        Some("thinking" | "redacted_thinking") => {}
                        // Another model took over after a refusal: the tool calls begun before the
                        // switch are not echoed back, so they are not run either. Text stays.
                        Some("fallback") => {
                            self.fragments.clear();
                        }
                        _ => {
                            let initial = block.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                            self.give_text(&initial, out);
                        }
                    }
                }
            }
            Some("content_block_delta") => {
                let index = obj.get("index").and_then(Value::as_i64).unwrap_or(0);
                if let Some(delta) = obj.get("delta").and_then(Value::as_object) {
                    // `thinking_delta` (field `thinking`) and `signature_delta` carry no `text`.
                    if delta.get("type").and_then(Value::as_str).is_some_and(|t| t == "thinking_delta" || t == "signature_delta") {
                        return Ok(Next::More);
                    }
                    if let Some(t) = delta.get("text").and_then(Value::as_str) {
                        self.give_text(t, out);
                    } else if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                        if let Some(tool) = self.fragments.get_mut(&index) {
                            tool.arguments.push_str(partial);
                        }
                    }
                }
            }
            Some("message_delta") => {
                let delta = obj.get("delta");
                if let Some(r) = delta.and_then(|d| d.get("stop_reason")).and_then(Value::as_str) {
                    self.reason = Some(r.to_string());
                }
                // `stop_details` is set only on a refusal (`category`, `explanation`; either may be null).
                if let Some(details) = delta.and_then(|d| d.get("stop_details")).or_else(|| obj.get("stop_details")).and_then(Value::as_object) {
                    self.category = details.get("category").and_then(Value::as_str).map(str::to_string);
                    self.explanation = details.get("explanation").and_then(Value::as_str).map(str::to_string);
                }
            }
            Some("error") => {
                let message = obj.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("Unknown streaming error.");
                return Err(LlmError::Http(0, message.to_string()));
            }
            Some("message_stop") => return Ok(Next::Ended),
            _ => {}
        }
        Ok(Next::More)
    }

    fn openai(&mut self, line: &str, out: &mut Vec<AiEvent>) -> Next {
        let Some(payload) = data_payload(line) else { return Next::More };
        if payload == "[DONE]" {
            return Next::Ended;
        }
        let Some(obj) = json_object(payload) else { return Next::More };
        let Some(first) = obj.get("choices").and_then(Value::as_array).and_then(|c| c.first()) else { return Next::More };
        if let Some(r) = first.get("finish_reason").and_then(Value::as_str) {
            self.reason = Some(r.to_string());
        }
        let Some(delta) = first.get("delta").and_then(Value::as_object) else { return Next::More };
        if let Some(t) = delta.get("content").and_then(Value::as_str) {
            self.give_text(t, out);
        }
        for tc in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            let index = tc.get("index").and_then(Value::as_i64).unwrap_or(0);
            let function = tc.get("function").and_then(Value::as_object);
            let name = function.and_then(|f| f.get("name")).and_then(Value::as_str);
            match self.fragments.get_mut(&index) {
                None => {
                    let id = tc.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("call-{}", uuid()));
                    self.fragments.insert(index, ToolFragments { id, name: name.unwrap_or("").to_string(), arguments: String::new() });
                }
                Some(tool) => {
                    if let Some(n) = name {
                        tool.name.push_str(n);
                    }
                }
            }
            if let Some(args) = function.and_then(|f| f.get("arguments")).and_then(Value::as_str) {
                if let Some(tool) = self.fragments.get_mut(&index) {
                    tool.arguments.push_str(args);
                }
            }
        }
        Next::More
    }

    /// OpenAI's Responses API stream (developers.openai.com/api/reference/resources/responses/
    /// streaming-events; the function-calling guide's "Streaming" section). Each event is a
    /// `data:` line whose JSON has a `type`; the `event:` lines are skipped, and the stream ends
    /// with `response.completed` (or `.incomplete`, `.failed`), not `[DONE]`.
    ///
    /// - `response.output_text.delta` (`delta`): text, given at once.
    /// - `response.refusal.delta` / `.done` (`delta` / `refusal`): the model declined; kept as the explanation.
    /// - `response.output_item.added` (`output_index`, `item`): a `function_call` item starts
    ///   (`call_id`, `name`, `arguments` empty so far).
    /// - `response.function_call_arguments.delta` / `.done` (`output_index`, `delta` / `arguments`).
    /// - `response.output_item.done` (`output_index`, `item`): the finished item, kept to replay
    ///   (reasoning items carry their `encrypted_content` only here, not in `.added`).
    /// - `response.completed`, `response.incomplete` (`response.incomplete_details.reason`),
    ///   `response.failed` (`response.error.message`), `error` (`message`).
    fn responses(&mut self, line: &str, out: &mut Vec<AiEvent>) -> Result<Next, LlmError> {
        let Some(obj) = data_payload(line).and_then(json_object) else { return Ok(Next::More) };
        let index = obj.get("output_index").and_then(Value::as_i64).unwrap_or(0);
        match obj.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(t) = obj.get("delta").and_then(Value::as_str) {
                    self.give_text(t, out);
                }
            }
            Some("response.refusal.delta") => {
                if let Some(t) = obj.get("delta").and_then(Value::as_str) {
                    self.explanation.get_or_insert_with(String::new).push_str(t);
                }
                self.reason = Some("refusal".into());
            }
            Some("response.refusal.done") => {
                if let Some(t) = obj.get("refusal").and_then(Value::as_str) {
                    self.explanation = Some(t.to_string());
                }
                self.reason = Some("refusal".into());
            }
            Some("response.output_item.added") => {
                let item = obj.get("item");
                if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("function_call") {
                    let field = |k: &str| item.and_then(|i| i.get(k)).and_then(Value::as_str).map(str::to_string);
                    let id = field("call_id").unwrap_or_else(|| format!("call-{}", uuid()));
                    self.fragments.insert(index, ToolFragments { id, name: field("name").unwrap_or_default(), arguments: field("arguments").unwrap_or_default() });
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let (Some(tool), Some(d)) = (self.fragments.get_mut(&index), obj.get("delta").and_then(Value::as_str)) {
                    tool.arguments.push_str(d);
                }
            }
            Some("response.function_call_arguments.done") => {
                if let (Some(tool), Some(a)) = (self.fragments.get_mut(&index), obj.get("arguments").and_then(Value::as_str)) {
                    tool.arguments = a.to_string();
                }
            }
            Some("response.output_item.done") => {
                if let Some(item) = obj.get("item").filter(|i| i.is_object()) {
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
                        let prior = self.fragments.remove(&index);
                        let id = field("call_id").or_else(|| prior.as_ref().map(|p| p.id.clone())).unwrap_or_else(|| format!("call-{}", uuid()));
                        let name = field("name").or_else(|| prior.as_ref().map(|p| p.name.clone())).unwrap_or_default();
                        let arguments = field("arguments").or_else(|| prior.map(|p| p.arguments)).unwrap_or_default();
                        self.fragments.insert(index, ToolFragments { id, name, arguments });
                    }
                    self.items.insert(index, item.clone());
                }
            }
            Some("response.completed") => {
                if self.reason.is_none() {
                    self.reason = Some("completed".into());
                }
                return Ok(Next::Ended);
            }
            Some("response.incomplete") => {
                let why = obj.get("response").and_then(|r| r.get("incomplete_details")).and_then(|d| d.get("reason")).and_then(Value::as_str);
                self.reason = Some(why.unwrap_or("incomplete").to_string());
                return Ok(Next::Ended);
            }
            Some("response.failed") => {
                let message = obj.get("response").and_then(|r| r.get("error")).and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("Unknown streaming error.");
                return Err(LlmError::Http(0, message.to_string()));
            }
            Some("error") => {
                let message = obj.get("message").or_else(|| obj.get("error").and_then(|e| e.get("message"))).and_then(Value::as_str).unwrap_or("Unknown streaming error.");
                return Err(LlmError::Http(0, message.to_string()));
            }
            _ => {}
        }
        Ok(Next::More)
    }

    fn ollama(&mut self, line: &str, out: &mut Vec<AiEvent>) -> Result<Next, LlmError> {
        let Some(obj) = json_object(line) else { return Ok(Next::More) };
        if let Some(err) = obj.get("error").and_then(Value::as_str) {
            return Err(LlmError::Http(0, err.to_string()));
        }
        // 0.90.34 looked at `done` only on a line that has a `message`.
        let Some(message) = obj.get("message").and_then(Value::as_object) else { return Ok(Next::More) };
        if let Some(t) = message.get("content").and_then(Value::as_str) {
            self.give_text(t, out);
        }
        for tc in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            let function = tc.get("function").and_then(Value::as_object);
            let Some(name) = function.and_then(|f| f.get("name")).and_then(Value::as_str) else { continue };
            let input = function.and_then(|f| f.get("arguments")).and_then(Value::as_object).cloned().unwrap_or_default();
            // Ollama sends no id; 0.90.34 makes one up so results can be threaded back (AI-011).
            self.calls.push(ToolCall { id: format!("ollama-{}", uuid()), name: name.to_string(), input });
        }
        if let Some(r) = obj.get("done_reason").and_then(Value::as_str) {
            self.reason = Some(r.to_string());
        }
        Ok(if obj.get("done").and_then(Value::as_bool) == Some(true) { Next::Ended } else { Next::More })
    }

    /// The end of the stream: the tool calls, in the reply's order, and why it stopped; or
    /// 0.90.34's sentence for an answer with neither text nor a tool call (AI-024).
    pub fn finish(mut self, out: &mut Vec<AiEvent>) -> Result<StopReason, LlmError> {
        let mut calls = std::mem::take(&mut self.calls);
        match self.provider {
            Provider::Anthropic => {
                for index in std::mem::take(&mut self.order) {
                    if let Some(tool) = self.fragments.remove(&index) {
                        calls.push(tool.call());
                    }
                }
            }
            Provider::Openai | Provider::Lmstudio => {
                let mut indices: Vec<i64> = self.fragments.keys().copied().collect();
                indices.sort();
                for index in indices {
                    if let Some(tool) = self.fragments.remove(&index) {
                        calls.push(tool.call());
                    }
                }
            }
            Provider::Ollama => {}
        }
        // A declined reply: no tool call of it runs, and it is not an empty-answer error. The
        // pane says so in its words and drops the partial text (the refusals guide: discard it).
        if self.reason.as_deref() == Some("refusal") {
            out.push(AiEvent::Refused { category: self.category.take(), explanation: self.explanation.take() });
            return Ok(StopReason::Refusal);
        }
        if !self.text && calls.is_empty() {
            if stop_reason(self.reason.as_deref(), false) == StopReason::MaxTokens {
                // A reasoning model can spend the whole limit before writing anything.
                return Err(LlmError::Decoding("The reply reached the Max tokens limit before any text was written. Raise Max tokens in Settings ▸ AI Assistant.".into()));
            }
            return Err(LlmError::Decoding(
                match self.provider {
                    Provider::Anthropic => "Anthropic stream ended without any content blocks.",
                    Provider::Openai => "OpenAI stream ended with neither text nor function calls.",
                    Provider::Lmstudio => "Stream ended with neither `content` nor `tool_calls`.",
                    Provider::Ollama => "Ollama stream ended with neither `content` nor `tool_calls`.",
                }
                .to_string(),
            ));
        }
        if self.provider == Provider::Openai && !self.items.is_empty() {
            let items: Vec<Value> = std::mem::take(&mut self.items).into_values().collect();
            out.push(AiEvent::Replay { replay: Replay { provider: Provider::Openai, model: self.model.clone(), items } });
        }
        let has_calls = !calls.is_empty();
        out.extend(calls.into_iter().map(|call| AiEvent::ToolCall { call }));
        Ok(stop_reason(self.reason.as_deref(), has_calls))
    }
}

/// The neutral stop reason from a provider's word (Anthropic `stop_reason`, OpenAI Chat
/// Completions `finish_reason` or Responses status / `incomplete_details.reason`, Ollama
/// `done_reason`). A reply that asks for tools is `toolUse` whatever the server called it
/// (Ollama says "stop"; a Response says "completed").
fn stop_reason(reason: Option<&str>, has_calls: bool) -> StopReason {
    match reason {
        Some("max_tokens" | "length" | "max_output_tokens") => StopReason::MaxTokens,
        Some("refusal") => StopReason::Refusal,
        _ if has_calls => StopReason::ToolUse,
        None | Some("end_turn" | "stop" | "stop_sequence" | "completed") => StopReason::End,
        Some("tool_use" | "tool_calls") => StopReason::ToolUse,
        Some(_) => StopReason::Other,
    }
}
