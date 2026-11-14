//! The assistant's backend, tested without a provider and without the Keychain: pinned request
//! bodies, the stream parsers fed recorded-style bytes cut at every boundary, 0.90.34's error
//! sentences, Stop, and one end-to-end stream per wire format against a `TcpListener` on
//! 127.0.0.1 that plays the server.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::keys::{KeyStore, MemoryKeys};
use super::stream::{Lines, Next, Parser};
use super::wire::{self, Block};
use super::*;

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

/// A conversation as the pane sends it (src/lib/types.ts `AiChatRequest`): two tool rounds, one
/// failed result, an assistant turn with no text.
fn conversation(provider: &str, base_url: &str) -> ChatRequest {
    serde_json::from_value(json!({
        "provider": provider,
        "model": "model-x",
        "baseURL": base_url,
        "system": "  You are an assistant embedded in Qnet.\n",
        "messages": [
            {"role": "user", "text": "Add a station and run it."},
            {"role": "assistant", "text": "Adding it.", "toolCalls": [
                {"id": "call_1", "name": "add_node", "input": {"name": "S1", "kind": "station", "at": {"y": 40, "x": 120}}},
                {"id": "call_2", "name": "connect", "input": {"to": "S1", "from": "Source"}}
            ]},
            {"role": "tool", "results": [
                {"id": "call_1", "name": "add_node", "content": "Added station S1.", "isError": false},
                {"id": "call_2", "name": "connect", "content": "No node named Source.", "isError": true}
            ]},
            {"role": "assistant", "text": "", "toolCalls": [{"id": "call_3", "name": "run_solver", "input": {}}]},
            {"role": "tool", "results": [{"id": "call_3", "name": "run_solver", "content": "ρ = 0.5", "isError": false}]},
            {"role": "user", "text": "Thanks."}
        ],
        "tools": [{"name": "add_node", "description": "Adds a node.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}],
        "maxTokens": 4096,
        "temperature": 0.7,
        "timeoutSec": 60
    }))
    .unwrap()
}

fn plain(provider: &str, base_url: &str) -> ChatRequest {
    serde_json::from_value(json!({
        "provider": provider, "model": "model-x", "baseURL": base_url, "system": "Be brief.",
        "messages": [{"role": "user", "text": "Hello"}], "tools": [], "maxTokens": 256, "temperature": 0.5, "timeoutSec": 5
    }))
    .unwrap()
}

fn header<'a>(p: &'a wire::Prepared, name: &str) -> Option<&'a str> {
    p.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

const SCHEMA: &str = r#"{"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}"#;

// ── Request bodies (AI-002…AI-017) ──────────────────────────────────────────────────────────────

#[test]
fn anthropic_request_is_the_messages_api_with_tool_blocks() {
    let p = wire::prepare(&conversation("anthropic", "https://api.anthropic.com"), "sk-ant-test", true).unwrap();
    assert_eq!(p.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(header(&p, "x-api-key"), Some("sk-ant-test"));
    assert_eq!(header(&p, "anthropic-version"), Some("2023-06-01"));
    assert_eq!(header(&p, "Content-Type"), Some("application/json"));
    assert_eq!(header(&p, "Accept"), Some("text/event-stream"));
    assert_eq!(header(&p, "Authorization"), None);
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        p.body,
        json!({
            "model": "model-x",
            "max_tokens": 4096,
            "stream": true,
            "system": "You are an assistant embedded in Qnet.",
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "Add a station and run it."}]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Adding it."},
                    {"type": "tool_use", "id": "call_1", "name": "add_node", "input": {"name": "S1", "kind": "station", "at": {"x": 120, "y": 40}}},
                    {"type": "tool_use", "id": "call_2", "name": "connect", "input": {"from": "Source", "to": "S1"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "Added station S1."},
                    {"type": "tool_result", "tool_use_id": "call_2", "content": "No node named Source.", "is_error": true}
                ]},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "call_3", "name": "run_solver", "input": {}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_3", "content": "ρ = 0.5"}]},
                {"role": "user", "content": [{"type": "text", "text": "Thanks."}]}
            ],
            "tools": [{"name": "add_node", "description": "Adds a node.", "input_schema": schema}]
        })
    );
}

#[test]
fn anthropic_leaves_out_a_blank_system_prompt_and_an_empty_tool_list() {
    let mut r = plain("anthropic", "https://api.anthropic.com/");
    r.system = " \n ".into();
    let p = wire::prepare(&r, "k", true).unwrap();
    assert_eq!(p.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(p.body, json!({"model": "model-x", "max_tokens": 256, "stream": true, "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]}));
    // Test Connection's non-streaming send: no `stream`, no Accept.
    let once = wire::prepare(&r, "k", false).unwrap();
    assert_eq!(once.body.get("stream"), None);
    assert_eq!(header(&once, "Accept"), None);
}

#[test]
fn openai_request_is_the_responses_api_with_function_call_items() {
    let p = wire::prepare(&conversation("openai", "https://api.openai.com/v1"), "sk-test", true).unwrap();
    assert_eq!(p.url, "https://api.openai.com/v1/responses");
    assert_eq!(header(&p, "Authorization"), Some("Bearer sk-test"));
    assert_eq!(header(&p, "Accept"), Some("text/event-stream"));
    assert_eq!(header(&p, "x-api-key"), None);
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        p.body,
        json!({
            "model": "model-x",
            "instructions": "You are an assistant embedded in Qnet.",
            "max_output_tokens": 4096,
            "store": false,
            "stream": true,
            "tool_choice": "auto",
            "input": [
                {"role": "user", "content": "Add a station and run it."},
                {"role": "assistant", "content": "Adding it."},
                {"type": "function_call", "call_id": "call_1", "name": "add_node", "arguments": r#"{"at":{"x":120,"y":40},"kind":"station","name":"S1"}"#},
                {"type": "function_call", "call_id": "call_2", "name": "connect", "arguments": r#"{"from":"Source","to":"S1"}"#},
                {"type": "function_call_output", "call_id": "call_1", "output": "Added station S1."},
                {"type": "function_call_output", "call_id": "call_2", "output": "No node named Source."},
                {"type": "function_call", "call_id": "call_3", "name": "run_solver", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "call_3", "output": "ρ = 0.5"},
                {"role": "user", "content": "Thanks."}
            ],
            "tools": [{"type": "function", "name": "add_node", "description": "Adds a node.", "parameters": schema, "strict": false}]
        })
    );
    // Test Connection's send: no stream; the limit is at least the API's 16.
    let mut r = plain("openai", "https://api.openai.com/v1");
    r.max_tokens = 4;
    let once = wire::prepare(&r, "k", false).unwrap();
    assert_eq!(once.body, json!({"model": "model-x", "instructions": "Be brief.", "input": [{"role": "user", "content": "Hello"}], "max_output_tokens": 16, "store": false, "stream": false}));
}

#[test]
fn lm_studio_keeps_chat_completions_and_sends_a_key_only_when_there_is_one() {
    let r = conversation("lmstudio", "http://localhost:1234/v1");
    let p = wire::prepare(&r, "", true).unwrap();
    assert_eq!(p.url, "http://localhost:1234/v1/chat/completions");
    assert_eq!(header(&p, "Authorization"), None);
    assert_eq!(header(&p, "Accept"), Some("text/event-stream"));
    assert_eq!(header(&wire::prepare(&r, "lm-key", true).unwrap(), "Authorization"), Some("Bearer lm-key"));
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        p.body,
        json!({
            "model": "model-x",
            "max_tokens": 4096,
            "temperature": 0.7,
            "stream": true,
            "tool_choice": "auto",
            "messages": [
                {"role": "system", "content": "You are an assistant embedded in Qnet."},
                {"role": "user", "content": "Add a station and run it."},
                {"role": "assistant", "content": "Adding it.", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "add_node", "arguments": r#"{"at":{"x":120,"y":40},"kind":"station","name":"S1"}"#}},
                    {"id": "call_2", "type": "function", "function": {"name": "connect", "arguments": r#"{"from":"Source","to":"S1"}"#}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "Added station S1."},
                {"role": "tool", "tool_call_id": "call_2", "content": "No node named Source."},
                {"role": "assistant", "content": null, "tool_calls": [{"id": "call_3", "type": "function", "function": {"name": "run_solver", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "call_3", "content": "ρ = 0.5"},
                {"role": "user", "content": "Thanks."}
            ],
            "tools": [{"type": "function", "function": {"name": "add_node", "description": "Adds a node.", "parameters": schema}}]
        })
    );
}

#[test]
fn ollama_request_is_native_chat_with_object_arguments_and_no_ids() {
    let p = wire::prepare(&conversation("ollama", "http://localhost:11434"), "ignored", true).unwrap();
    assert_eq!(p.url, "http://localhost:11434/api/chat");
    assert_eq!(p.headers, vec![("Content-Type", "application/json".to_string())]);
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        p.body,
        json!({
            "model": "model-x",
            "stream": true,
            "options": {"temperature": 0.7, "num_predict": 4096},
            "messages": [
                {"role": "system", "content": "You are an assistant embedded in Qnet."},
                {"role": "user", "content": "Add a station and run it."},
                {"role": "assistant", "content": "Adding it.", "tool_calls": [
                    {"function": {"name": "add_node", "arguments": {"name": "S1", "kind": "station", "at": {"x": 120, "y": 40}}}},
                    {"function": {"name": "connect", "arguments": {"from": "Source", "to": "S1"}}}
                ]},
                {"role": "tool", "content": "Added station S1."},
                {"role": "tool", "content": "No node named Source."},
                {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "run_solver", "arguments": {}}}]},
                {"role": "tool", "content": "ρ = 0.5"},
                {"role": "user", "content": "Thanks."}
            ],
            "tools": [{"type": "function", "function": {"name": "add_node", "description": "Adds a node.", "parameters": schema}}]
        })
    );
}

#[test]
fn without_tools_openai_and_ollama_flatten_the_history_to_text() {
    let mut r = conversation("lmstudio", "http://localhost:1234/v1");
    r.tools.clear();
    let expected = json!([
        {"role": "system", "content": "You are an assistant embedded in Qnet."},
        {"role": "user", "content": "Add a station and run it."},
        {"role": "assistant", "content": "Adding it.\n[assistant requested tool: add_node input={\"at\":{\"x\":120,\"y\":40},\"kind\":\"station\",\"name\":\"S1\"}]\n[assistant requested tool: connect input={\"from\":\"Source\",\"to\":\"S1\"}]"},
        {"role": "user", "content": "[tool result: Added station S1.]\n[tool error: No node named Source.]"},
        {"role": "assistant", "content": "[assistant requested tool: run_solver input={}]"},
        {"role": "user", "content": "[tool result: ρ = 0.5]"},
        {"role": "user", "content": "Thanks."}
    ]);
    let p = wire::prepare(&r, "k", false).unwrap();
    assert_eq!(p.body, json!({"model": "model-x", "max_tokens": 4096, "temperature": 0.7, "stream": false, "messages": expected}));
    // The Responses API: the same text items, the system prompt as `instructions`.
    let mut o = r.clone();
    o.provider = Provider::Openai;
    let p = wire::prepare(&o, "k", false).unwrap();
    assert_eq!(p.body["input"], Value::Array(expected.as_array().unwrap()[1..].to_vec()));
    assert_eq!(p.body["instructions"], json!("You are an assistant embedded in Qnet."));
    assert_eq!(p.body.get("tools"), None);
    r.provider = Provider::Ollama;
    r.base_url = "http://localhost:11434".into();
    let p = wire::prepare(&r, "", false).unwrap();
    assert_eq!(p.body, json!({"model": "model-x", "stream": false, "options": {"temperature": 0.7, "num_predict": 4096}, "messages": expected}));
}

#[test]
fn a_request_that_is_not_configured_is_refused_in_0_90_34s_words() {
    let refusal = |r: &ChatRequest, key: &str| wire::prepare(r, key, true).unwrap_err().to_string();
    let ok = plain("anthropic", "https://api.anthropic.com");
    let mut r = ok.clone();
    r.model = "  ".into();
    r.base_url = "".into();
    assert_eq!(refusal(&r, ""), "AI backend not configured: Model name is empty.");
    r.model = "m".into();
    assert_eq!(refusal(&r, ""), "AI backend not configured: Base URL is empty.");
    assert_eq!(refusal(&ok, " "), "AI backend not configured: API key is required for Anthropic (Claude API).");
    assert_eq!(refusal(&plain("openai", "https://api.openai.com/v1"), ""), "AI backend not configured: API key is required for OpenAI.");
    assert_eq!(refusal(&plain("ollama", "not a url"), ""), "AI backend not configured: Invalid base URL.");
    assert_eq!(refusal(&plain("lmstudio", "ftp://host/v1"), ""), "AI backend not configured: Invalid base URL.");
    // The local providers need no key.
    assert!(wire::prepare(&plain("ollama", "http://localhost:11434"), "", true).is_ok());
    assert!(wire::prepare(&plain("lmstudio", "http://localhost:1234/v1"), "", true).is_ok());
}

#[test]
fn the_contract_types_cross_ipc_in_the_pages_shape() {
    let events = vec![
        AiEvent::Text { delta: "Hi".into() },
        AiEvent::ToolCall { call: ToolCall { id: "c1".into(), name: "add_node".into(), input: json!({"name": "S1"}).as_object().unwrap().clone() } },
        AiEvent::Done { stop_reason: StopReason::MaxTokens },
        AiEvent::Done { stop_reason: StopReason::ToolUse },
        AiEvent::Error { message: "HTTP 401: no".into() },
    ];
    assert_eq!(
        serde_json::to_value(&events).unwrap(),
        json!([
            {"kind": "text", "delta": "Hi"},
            {"kind": "toolCall", "call": {"id": "c1", "name": "add_node", "input": {"name": "S1"}}},
            {"kind": "done", "stopReason": "maxTokens"},
            {"kind": "done", "stopReason": "toolUse"},
            {"kind": "error", "message": "HTTP 401: no"}
        ])
    );
    assert_eq!(serde_json::to_value([StopReason::End, StopReason::Cancelled, StopReason::Other]).unwrap(), json!(["end", "cancelled", "other"]));
    let r = conversation("lmstudio", "http://localhost:1234/v1");
    assert_eq!(r.provider, Provider::Lmstudio);
    assert_eq!((r.max_tokens, r.temperature, r.timeout_sec), (4096, 0.7, 60.0));
    assert!(serde_json::from_value::<Provider>(json!("gemini")).is_err());
    assert_eq!(serde_json::to_value(TestOutcome { ok: true, message: "Reply: pong".into() }).unwrap(), json!({"ok": true, "message": "Reply: pong"}));
}

#[test]
fn made_up_ids_are_swift_style_uuids() {
    let id = wire::uuid();
    assert_eq!(id.len(), 36);
    assert!(id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_digit() || ('A'..='F').contains(&c) }), "{id}");
    assert_ne!(id, wire::uuid());
}

// ── Stream parsers (AI-020…AI-024, AI-026) ──────────────────────────────────────────────────────

const ANTHROPIC_STREAM: &str = concat!(
    "event: message_start\r\n",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"content\":[]}}\r\n\r\n",
    "event: content_block_start\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: ping\ndata: {\"type\":\"ping\"}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ajout d’une file — \"}}\n\n",
    "data:{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"待ち行列 🚦\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"add_node\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"name\\\": \\\"S\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"1\\\", \\\"rate\\\": 2.5}\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_02\",\"name\":\"run_solver\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":42}}\n\n",
    "data: {\"type\":\"message_stop\"}\n\n",
);

const CHAT_STREAM: &str = concat!(
    ": keep-alive comment\n\n",
    "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ajout d’une file — \"},\"finish_reason\":null}]}\n\n",
    "data: not json\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"待ち行列 🚦\"},\"finish_reason\":null}]}\r\n\r\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"run_\",\"arguments\":\"\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"add_node\",\"arguments\":\"{\\\"name\\\":\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" \\\"S1\\\", \\\"rate\\\": 2.5}\"}},{\"index\":1,\"function\":{\"name\":\"solver\",\"arguments\":\"not json\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"total_tokens\":9}}\n\n",
    "data: [DONE]\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"after the end\"}}]}\n\n",
);

const OLLAMA_STREAM: &str = concat!(
    "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"Ajout d’une file — \"},\"done\":false}\n",
    "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":false}\n",
    "half a line that is not JSON\n",
    "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"待ち行列 🚦\"},\"done\":false}\r\n",
    "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"add_node\",\"arguments\":{\"name\":\"S1\",\"rate\":2.5}}},{\"function\":{\"arguments\":{}}},{\"function\":{\"name\":\"run_solver\",\"arguments\":\"oops\"}}]},\"done\":false}\n",
    "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done_reason\":\"stop\",\"done\":true}",
);

/// Feeds `bytes` in the given chunks; the events, and how the stream ended.
fn parse(provider: Provider, chunks: &[&[u8]]) -> (Vec<AiEvent>, Result<StopReason, LlmError>) {
    let mut lines = Lines::default();
    let mut parser = Parser::new(provider);
    let mut events = Vec::new();
    let mut ended = false;
    'read: for chunk in chunks {
        for line in lines.push(chunk) {
            match parser.line(&line, &mut events) {
                Err(e) => return (events, Err(e)),
                Ok(Next::Ended) => {
                    ended = true;
                    break 'read;
                }
                Ok(Next::More) => {}
            }
        }
    }
    if !ended {
        if let Some(line) = lines.finish() {
            if let Err(e) = parser.line(&line, &mut events) {
                return (events, Err(e));
            }
        }
    }
    let end = parser.finish(&mut events);
    (events, end)
}

/// The deltas joined, and the events that are not text; ids made up by Qnet are masked.
fn summary(events: &[AiEvent]) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut rest = Vec::new();
    for e in events {
        match e {
            AiEvent::Text { delta } => {
                assert!(!delta.is_empty(), "an empty delta was sent");
                text.push_str(delta);
            }
            AiEvent::ToolCall { call } => {
                let id = match call.id.split_once('-') {
                    Some((prefix @ ("ollama" | "call"), uuid)) if uuid.len() == 36 => format!("{prefix}-<uuid>"),
                    _ => call.id.clone(),
                };
                rest.push(json!({"id": id, "name": call.name, "input": call.input}));
            }
            other => rest.push(serde_json::to_value(other).unwrap()),
        }
    }
    (text, rest)
}

/// The same answer whatever the chunking: whole, byte by byte, and cut in two at every byte
/// (so inside every multi-byte character, every `\r\n` and every line).
fn every_chunking(provider: Provider, stream: &str) -> (String, Vec<Value>, StopReason) {
    let bytes = stream.as_bytes();
    let (events, end) = parse(provider, &[bytes]);
    let whole = (summary(&events), end.clone().unwrap());
    let single: Vec<&[u8]> = bytes.chunks(1).collect();
    let (events, end) = parse(provider, &single);
    assert_eq!((summary(&events), end.unwrap()), whole, "byte by byte");
    for cut in 1..bytes.len() {
        let (events, end) = parse(provider, &[&bytes[..cut], &bytes[cut..]]);
        assert_eq!((summary(&events), end.unwrap()), whole, "cut at byte {cut}");
    }
    for size in [2, 3, 5, 7, 64] {
        let chunks: Vec<&[u8]> = bytes.chunks(size).collect();
        let (events, end) = parse(provider, &chunks);
        assert_eq!((summary(&events), end.unwrap()), whole, "chunks of {size}");
    }
    (whole.0 .0, whole.0 .1, whole.1)
}

#[test]
fn anthropic_stream_gives_text_as_it_comes_then_the_tool_calls_in_block_order() {
    let (text, rest, stop) = every_chunking(Provider::Anthropic, ANTHROPIC_STREAM);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(rest, vec![json!({"id": "toolu_01", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}), json!({"id": "toolu_02", "name": "run_solver", "input": {}})]);
    assert_eq!(stop, StopReason::ToolUse);
    // Text deltas arrive before the stream ends: after the first delta's line, one event is out.
    let mut parser = Parser::new(Provider::Anthropic);
    let mut out = Vec::new();
    parser.line(r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"He"}}"#, &mut out).unwrap();
    parser.line(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}"#, &mut out).unwrap();
    assert_eq!(out, vec![AiEvent::Text { delta: "He".into() }, AiEvent::Text { delta: "llo".into() }]);
}

#[test]
fn chat_completions_stream_accumulates_tool_calls_by_index_until_done() {
    let (text, rest, stop) = every_chunking(Provider::Lmstudio, CHAT_STREAM);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    // Index order, not arrival order; a missing id is made up; arguments that are not JSON become {}.
    assert_eq!(rest, vec![json!({"id": "call_a", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}), json!({"id": "call-<uuid>", "name": "run_solver", "input": {}})]);
    assert_eq!(stop, StopReason::ToolUse);
}

#[test]
fn ollama_stream_is_one_json_object_per_line() {
    let (text, rest, stop) = every_chunking(Provider::Ollama, OLLAMA_STREAM);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    // A call without a name is skipped; arguments that are not an object become {}.
    assert_eq!(rest, vec![json!({"id": "ollama-<uuid>", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}), json!({"id": "ollama-<uuid>", "name": "run_solver", "input": {}})]);
    assert_eq!(stop, StopReason::ToolUse);
}

#[test]
fn stop_reasons_are_read_so_a_reply_cut_at_max_tokens_shows() {
    let anthropic = |reason: &str| {
        let s = format!(
            "data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"Hi\"}}}}\n\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{reason}\"}}}}\n\ndata: {{\"type\":\"message_stop\"}}\n\n"
        );
        parse(Provider::Anthropic, &[s.as_bytes()]).1.unwrap()
    };
    assert_eq!(anthropic("end_turn"), StopReason::End);
    assert_eq!(anthropic("stop_sequence"), StopReason::End);
    assert_eq!(anthropic("max_tokens"), StopReason::MaxTokens);
    assert_eq!(anthropic("refusal"), StopReason::Refusal);
    assert_eq!(anthropic("pause_turn"), StopReason::Other);
    let openai = |reason: &str| {
        let s = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"Hi\"}},\"finish_reason\":null}}]}}\n\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"{reason}\"}}]}}\n\ndata: [DONE]\n\n");
        parse(Provider::Lmstudio, &[s.as_bytes()]).1.unwrap()
    };
    assert_eq!(openai("stop"), StopReason::End);
    assert_eq!(openai("length"), StopReason::MaxTokens);
    assert_eq!(openai("content_filter"), StopReason::Other);
    let ollama = |reason: &str| {
        let s = format!("{{\"message\":{{\"content\":\"Hi\"}},\"done\":false}}\n{{\"message\":{{\"content\":\"\"}},\"done_reason\":\"{reason}\",\"done\":true}}\n");
        parse(Provider::Ollama, &[s.as_bytes()]).1.unwrap()
    };
    assert_eq!(ollama("stop"), StopReason::End);
    assert_eq!(ollama("length"), StopReason::MaxTokens);
    // No reason given at all (a server that just closes): a complete answer.
    assert_eq!(parse(Provider::Ollama, &[b"{\"message\":{\"content\":\"Hi\"}}\n"]).1.unwrap(), StopReason::End);
}

#[test]
fn stream_errors_read_as_0_90_34s_sentences() {
    let err = |provider, s: &str| parse(provider, &[s.as_bytes()]).1.unwrap_err().to_string();
    assert_eq!(err(Provider::Anthropic, "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"), "HTTP 0: Overloaded");
    assert_eq!(err(Provider::Anthropic, "data: {\"type\":\"error\"}\n\n"), "HTTP 0: Unknown streaming error.");
    assert_eq!(err(Provider::Ollama, "{\"error\":\"model 'x' not found\"}\n"), "HTTP 0: model 'x' not found");
    // An answer with neither text nor a tool call.
    assert_eq!(err(Provider::Anthropic, "data: {\"type\":\"message_start\"}\n\ndata: {\"type\":\"message_stop\"}\n\n"), "Response parse error: Anthropic stream ended without any content blocks.");
    assert_eq!(err(Provider::Anthropic, ""), "Response parse error: Anthropic stream ended without any content blocks.");
    assert_eq!(err(Provider::Lmstudio, "data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\ndata: [DONE]\n\n"), "Response parse error: Stream ended with neither `content` nor `tool_calls`.");
    assert_eq!(err(Provider::Lmstudio, "<html>not a stream</html>"), "Response parse error: Stream ended with neither `content` nor `tool_calls`.");
    assert_eq!(err(Provider::Ollama, "{\"message\":{\"content\":\"\"},\"done\":true}\n"), "Response parse error: Ollama stream ended with neither `content` nor `tool_calls`.");
    // Text given before a mid-stream error stays given; no tool call follows an error.
    let (events, end) = parse(Provider::Anthropic, &[b"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Par\"}}\n\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"n\"}}\n\ndata: {\"type\":\"error\",\"error\":{\"message\":\"boom\"}}\n\n"]);
    assert_eq!(events, vec![AiEvent::Text { delta: "Par".into() }]);
    assert_eq!(end.unwrap_err().to_string(), "HTTP 0: boom");
}

#[test]
fn http_errors_carry_the_body_cut_to_500_characters() {
    assert_eq!(wire::http_error(401, br#"{"error":{"message":"invalid x-api-key"}}"#).to_string(), r#"HTTP 401: {"error":{"message":"invalid x-api-key"}}"#);
    let long = "é".repeat(600);
    assert_eq!(wire::http_error(500, long.as_bytes()).to_string(), format!("HTTP 500: {}…", "é".repeat(500)));
    assert_eq!(wire::http_error(500, "é".repeat(500).as_bytes()).to_string(), format!("HTTP 500: {}", "é".repeat(500)));
    assert_eq!(wire::http_error(502, &[0xff, 0xfe, 0x00]).to_string(), "HTTP 502: <non-utf8 body>");
    assert_eq!(wire::http_error(404, b"").to_string(), "HTTP 404: ");
    assert_eq!(LlmError::Transport("The request timed out.".into()).to_string(), "Network error: The request timed out.");
}

// ── Non-streaming replies, Test Connection and model discovery (AI-095…AI-099) ──────────────────

#[test]
fn test_connection_reads_a_whole_reply_and_says_what_came_back() {
    let reply = |provider, body: &str| wire::parse_reply(provider, body.as_bytes()).map(|b| wire::test_sentence(&b)).map_err(|e| e.to_string());
    assert_eq!(reply(Provider::Anthropic, r#"{"content":[{"type":"text","text":" pong\n"}]}"#).unwrap(), "Reply: pong");
    assert_eq!(reply(Provider::Anthropic, r#"{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#).unwrap(), "Reply: a b");
    assert_eq!(reply(Provider::Anthropic, r#"{"content":[{"type":"tool_use","id":"t","name":"n","input":{}}]}"#).unwrap(), "Connected (no text returned).");
    assert_eq!(reply(Provider::Anthropic, r#"{"type":"error"}"#).unwrap_err(), "Response parse error: Missing `content` array in Anthropic response.");
    assert_eq!(reply(Provider::Anthropic, r#"{"content":[{"type":"thinking"}]}"#).unwrap_err(), "Response parse error: Anthropic response had no usable content blocks.");
    assert_eq!(reply(Provider::Lmstudio, r#"{"choices":[{"message":{"role":"assistant","content":"pong"}}]}"#).unwrap(), "Reply: pong");
    assert_eq!(reply(Provider::Lmstudio, r#"{"choices":[{"message":{"content":"   "}}]}"#).unwrap(), "Connected (no text returned).");
    assert_eq!(reply(Provider::Lmstudio, r#"{"choices":[]}"#).unwrap_err(), "Response parse error: Missing `choices[0].message` in response.");
    assert_eq!(reply(Provider::Lmstudio, "<html>").unwrap_err(), "Response parse error: Missing `choices[0].message` in response.");
    assert_eq!(reply(Provider::Lmstudio, r#"{"choices":[{"message":{"content":null}}]}"#).unwrap_err(), "Response parse error: OpenAI response had neither `content` nor `tool_calls`.");
    assert_eq!(reply(Provider::Ollama, r#"{"message":{"role":"assistant","content":"pong"},"done":true}"#).unwrap(), "Reply: pong");
    assert_eq!(reply(Provider::Ollama, r#"{"error":"no"}"#).unwrap_err(), "Response parse error: Missing `message` in Ollama response.");
    assert_eq!(reply(Provider::Ollama, r#"{"message":{"content":""}}"#).unwrap_err(), "Response parse error: Ollama response had neither `content` nor `tool_calls`.");
    // The first 80 characters, then an ellipsis.
    let long = format!(r#"{{"message":{{"content":"{}"}}}}"#, "é".repeat(81));
    assert_eq!(reply(Provider::Ollama, &long).unwrap(), format!("Reply: {}…", "é".repeat(80)));
    let exact = format!(r#"{{"message":{{"content":"{}"}}}}"#, "é".repeat(80));
    assert_eq!(reply(Provider::Ollama, &exact).unwrap(), format!("Reply: {}", "é".repeat(80)));
    // A tool call in a whole reply is parsed as the streamed ones are.
    let blocks = wire::parse_reply(Provider::Lmstudio, br#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c","function":{"name":"n","arguments":"{\"a\":1}"}}]}}]}"#).unwrap();
    assert_eq!(blocks, vec![Block::Tool(ToolCall { id: "c".into(), name: "n".into(), input: json!({"a": 1}).as_object().unwrap().clone() })]);
}

#[test]
fn test_connection_sends_the_pong_message_with_the_stored_generation_settings() {
    let stored = json!({"ai.systemPrompt": "Be terse.", "ai.maxTokens": 512, "ai.temperature": 0.2, "ai.timeoutSec": 15.0});
    let settings = crate::settings_schema::with_defaults(stored.as_object().unwrap());
    let r = test_request(Provider::Ollama, "http://localhost:11434".into(), "llama3.2".into(), &settings);
    let p = wire::prepare(&r, "", false).unwrap();
    assert_eq!(
        p.body,
        json!({"model": "llama3.2", "stream": false, "options": {"temperature": 0.2, "num_predict": 512},
               "messages": [{"role": "system", "content": "Be terse."}, {"role": "user", "content": "Say the single word: pong"}]})
    );
    assert_eq!(r.timeout_sec, 15.0);
    // Nothing stored: the schema's defaults (4096 tokens, 0.7, 60 s).
    let defaults = crate::settings_schema::with_defaults(&serde_json::Map::new());
    let r = test_request(Provider::Anthropic, "https://api.anthropic.com".into(), "claude-sonnet-4-6".into(), &defaults);
    assert_eq!((r.max_tokens, r.temperature, r.timeout_sec), (4096, 0.7, 60.0));
    assert!(!r.system.is_empty());
}

#[test]
fn model_discovery_asks_each_providers_endpoint() {
    let ask = |provider, base: &str, key: &str| wire::models_request(provider, base, key);
    assert_eq!(ask(Provider::Openai, " https://api.openai.com/v1/ ", "sk").unwrap(), ("https://api.openai.com/v1/models".to_string(), vec![("Authorization", "Bearer sk".to_string())]));
    assert_eq!(ask(Provider::Lmstudio, "http://localhost:1234/v1", "").unwrap(), ("http://localhost:1234/v1/models".to_string(), vec![]));
    assert_eq!(ask(Provider::Ollama, "http://localhost:11434/", "").unwrap(), ("http://localhost:11434/api/tags".to_string(), vec![]));
    // SET-155 (Changed, D5): Anthropic's list comes from the Base URL's server.
    assert_eq!(
        ask(Provider::Anthropic, "https://proxy.example.com", "sk-ant").unwrap(),
        ("https://proxy.example.com/v1/models".to_string(), vec![("x-api-key", "sk-ant".to_string()), ("anthropic-version", "2023-06-01".to_string())])
    );
    let refusal = |provider, base: &str, key: &str| ask(provider, base, key).unwrap_err().to_string();
    assert_eq!(refusal(Provider::Ollama, "  ", ""), "AI backend not configured: Base URL is empty.");
    assert_eq!(refusal(Provider::Anthropic, "https://api.anthropic.com", " "), "AI backend not configured: API key required to list Anthropic models.");
    assert_eq!(refusal(Provider::Openai, "https://api.openai.com/v1", ""), "AI backend not configured: API key required to list OpenAI models.");
    assert_eq!(refusal(Provider::Ollama, "no scheme", ""), "AI backend not configured: Invalid model-list endpoint: no scheme/api/tags");
}

#[test]
fn model_lists_are_read_sorted_with_0_90_34s_errors() {
    let read = |provider, body: &str| wire::parse_models(provider, body.as_bytes()).map_err(|e| e.to_string());
    assert_eq!(read(Provider::Lmstudio, r#"{"object":"list","data":[{"id":"gpt-4o"},{"id":"gpt-4.1"},{"object":"model"},{"id":"babbage"}]}"#).unwrap(), ["babbage", "gpt-4.1", "gpt-4o"]);
    assert_eq!(read(Provider::Anthropic, r#"{"data":[{"id":"claude-sonnet-4-6"},{"id":"claude-haiku-4-5"}]}"#).unwrap(), ["claude-haiku-4-5", "claude-sonnet-4-6"]);
    assert_eq!(read(Provider::Ollama, r#"{"models":[{"name":"qwen2.5:7b"},{"name":"llama3.2:latest"}]}"#).unwrap(), ["llama3.2:latest", "qwen2.5:7b"]);
    assert_eq!(read(Provider::Lmstudio, r#"{"data":[]}"#).unwrap(), Vec::<String>::new());
    assert_eq!(read(Provider::Lmstudio, r#"{"models":[]}"#).unwrap_err(), "Response parse error: Missing `data[]` in model-list response.");
    assert_eq!(read(Provider::Openai, r#"{"data":["gpt-4o"]}"#).unwrap_err(), "Response parse error: Missing `data[]` in model-list response.");
    assert_eq!(read(Provider::Ollama, r#"{"data":[]}"#).unwrap_err(), "Response parse error: Missing `models[]` in /api/tags response.");
    assert_eq!(read(Provider::Ollama, "[1, 2]").unwrap_err(), "Response parse error: Could not parse model-list response.");
    assert_eq!(read(Provider::Openai, "<html>").unwrap_err(), "Response parse error: Could not parse model-list response.");
    assert_eq!(wire::models_http_error(401, "x".repeat(300).as_bytes()).to_string(), format!("HTTP 401: {}", "x".repeat(200)));
}

// ── Keys (§6.17, AI-092) ────────────────────────────────────────────────────────────────────────

#[test]
fn keys_are_stored_under_0_90_34s_keychain_names_and_a_failed_replace_keeps_the_old_key() {
    assert_eq!(keys::SERVICE, "com.bnetgui.ai");
    assert_eq!([Provider::Anthropic, Provider::Openai, Provider::Ollama, Provider::Lmstudio].map(Provider::id), ["anthropic", "openai", "ollama", "lmstudio"]);
    let keys = MemoryKeys::default();
    assert_eq!(keys.load(Provider::Anthropic).unwrap(), "");
    keys.save(Provider::Anthropic, "sk-ant-1").unwrap();
    keys.save(Provider::Anthropic, "sk-ant-2").unwrap();
    assert_eq!(keys.load(Provider::Anthropic).unwrap(), "sk-ant-2");
    assert_eq!(keys.load(Provider::Openai).unwrap(), "", "each provider has its own item");
    keys.save(Provider::Anthropic, "").unwrap();
    assert_eq!(keys.load(Provider::Anthropic).unwrap(), "");
    assert_eq!(
        *keys.writes.lock().unwrap(),
        ["set com.bnetgui.ai/anthropic", "set com.bnetgui.ai/anthropic", "delete com.bnetgui.ai/anthropic"]
    );
    // A write the Keychain refuses leaves the working key where it was (0.90.34 deleted it first).
    keys.save(Provider::Openai, "sk-old").unwrap();
    keys.refuse_writes.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(keys.save(Provider::Openai, "sk-new").is_err());
    assert_eq!(keys.load(Provider::Openai).unwrap(), "sk-old");
}

// ── End to end, against a server on 127.0.0.1 ───────────────────────────────────────────────────

enum Play {
    Send(Vec<u8>),
    Pause(u64),
    /// Keeps the connection open, silent, until the client goes away (or 10 s).
    Hold,
}

fn send(s: &str) -> Play {
    Play::Send(s.as_bytes().to_vec())
}

struct Seen {
    head: String,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|l| l.split_once(':').filter(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim()))
    }

    fn request_line(&self) -> &str {
        self.head.lines().next().unwrap_or("")
    }
}

fn read_request(stream: &mut TcpStream) -> Seen {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = stream.read(&mut tmp).unwrap();
        assert!(n > 0, "the client closed before sending a request");
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let length: usize = head.lines().find_map(|l| l.split_once(':').filter(|(n, _)| n.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse().ok())).unwrap_or(0);
    while buf.len() < head_end + length {
        let n = stream.read(&mut tmp).unwrap();
        assert!(n > 0);
        buf.extend_from_slice(&tmp[..n]);
    }
    Seen { head, body: serde_json::from_slice(&buf[head_end..head_end + length]).unwrap_or(Value::Null) }
}

/// A one-request server: answers with `status_line` and the played body, then closes. Gives its
/// base URL and, once the request has arrived, what it saw.
fn serve(status_line: &'static str, play: Vec<Play>) -> (String, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let seen = read_request(&mut stream);
        let _ = tx.send(seen);
        let _ = stream.write_all(format!("HTTP/1.1 {status_line}\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").as_bytes());
        let _ = stream.flush();
        for step in play {
            match step {
                Play::Send(bytes) => {
                    if stream.write_all(&bytes).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                }
                Play::Pause(ms) => std::thread::sleep(Duration::from_millis(ms)),
                Play::Hold => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let mut b = [0u8; 64];
                    while matches!(stream.read(&mut b), Ok(n) if n > 0) {}
                    return;
                }
            }
        }
    });
    (base, rx)
}

/// Cuts a recorded stream into awkward pieces (7 bytes at a time) with pauses, as a network would.
fn dribble(stream: &str) -> Vec<Play> {
    let mut play = Vec::new();
    for (i, chunk) in stream.as_bytes().chunks(7).enumerate() {
        play.push(Play::Send(chunk.to_vec()));
        if i % 40 == 0 {
            play.push(Play::Pause(2));
        }
    }
    play
}

fn ai_with(keys: &[(Provider, &str)]) -> Ai {
    let store = MemoryKeys::default();
    for (p, k) in keys {
        store.save(*p, k).unwrap();
    }
    Ai::new(Arc::new(store))
}

/// A request's events as they arrive.
struct Stream {
    id: String,
    rx: mpsc::Receiver<AiEvent>,
}

impl Stream {
    fn next(&self) -> AiEvent {
        self.rx.recv_timeout(Duration::from_secs(10)).expect("an event within 10 s")
    }

    /// Everything up to and including the last event (`done` or `error`).
    fn all(&self) -> Vec<AiEvent> {
        let mut out = Vec::new();
        loop {
            let e = self.next();
            let last = matches!(e, AiEvent::Done { .. } | AiEvent::Error { .. });
            out.push(e);
            if last {
                // Nothing may follow the last event.
                assert!(self.rx.recv_timeout(Duration::from_millis(50)).is_err());
                return out;
            }
        }
    }
}

fn start(ai: &Ai, request: ChatRequest) -> Stream {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let id = ai.start(request, move |e| tx.lock().unwrap().send(e).is_ok());
    Stream { id, rx }
}

#[test]
fn an_anthropic_stream_end_to_end() {
    let (base, seen) = serve("200 OK", dribble(ANTHROPIC_STREAM));
    let ai = ai_with(&[(Provider::Anthropic, "sk-ant-test")]);
    let request = conversation("anthropic", &base);
    let events = start(&ai, request.clone()).all();
    let (text, rest) = summary(&events);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(
        rest,
        vec![
            json!({"id": "toolu_01", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}),
            json!({"id": "toolu_02", "name": "run_solver", "input": {}}),
            json!({"kind": "done", "stopReason": "toolUse"})
        ]
    );
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "POST /v1/messages HTTP/1.1");
    assert_eq!(seen.header("x-api-key"), Some("sk-ant-test"));
    assert_eq!(seen.header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(seen.header("content-type"), Some("application/json"));
    assert_eq!(seen.header("accept"), Some("text/event-stream"));
    assert_eq!(seen.body, wire::prepare(&request, "sk-ant-test", true).unwrap().body);
    assert_eq!(ai.active_count(), 0);
}

#[test]
fn a_chat_completions_stream_end_to_end() {
    let (base, seen) = serve("200 OK", dribble(CHAT_STREAM));
    let ai = ai_with(&[(Provider::Lmstudio, "sk-test")]);
    let request = conversation("lmstudio", &format!("{base}/v1"));
    let events = start(&ai, request.clone()).all();
    let (text, rest) = summary(&events);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(
        rest,
        vec![
            json!({"id": "call_a", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}),
            json!({"id": "call-<uuid>", "name": "run_solver", "input": {}}),
            json!({"kind": "done", "stopReason": "toolUse"})
        ]
    );
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "POST /v1/chat/completions HTTP/1.1");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-test"));
    assert_eq!(seen.header("accept"), Some("text/event-stream"));
    assert_eq!(seen.body, wire::prepare(&request, "sk-test", true).unwrap().body);
}

#[test]
fn an_ollama_stream_end_to_end() {
    let (base, seen) = serve("200 OK", dribble(OLLAMA_STREAM));
    let ai = ai_with(&[]);
    let request = conversation("ollama", &base);
    let events = start(&ai, request.clone()).all();
    let (text, rest) = summary(&events);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(
        rest,
        vec![
            json!({"id": "ollama-<uuid>", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}),
            json!({"id": "ollama-<uuid>", "name": "run_solver", "input": {}}),
            json!({"kind": "done", "stopReason": "toolUse"})
        ]
    );
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "POST /api/chat HTTP/1.1");
    assert_eq!(seen.header("authorization"), None);
    assert_eq!(seen.header("x-api-key"), None);
    assert_eq!(seen.body, wire::prepare(&request, "", true).unwrap().body);
}

#[test]
fn a_plain_answer_ends_with_done_end() {
    let (base, _seen) = serve("200 OK", vec![send("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"), Play::Pause(20), send("data: {\"choices\":[{\"delta\":{\"content\":\" there\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")]);
    let events = start(&ai_with(&[]), plain("lmstudio", &format!("{base}/v1"))).all();
    assert_eq!(events, vec![AiEvent::Text { delta: "Hello".into() }, AiEvent::Text { delta: " there".into() }, AiEvent::Done { stop_reason: StopReason::End }]);
}

#[test]
fn a_missing_key_is_an_error_event_and_no_request_is_made() {
    let ai = ai_with(&[(Provider::Anthropic, "  ")]);
    let events = start(&ai, plain("anthropic", "http://127.0.0.1:9")).all();
    assert_eq!(events, vec![AiEvent::Error { message: "AI backend not configured: API key is required for Anthropic (Claude API).".into() }]);
    let events = start(&ai, plain("openai", "http://127.0.0.1:9")).all();
    assert_eq!(events, vec![AiEvent::Error { message: "AI backend not configured: API key is required for OpenAI.".into() }]);
    assert_eq!(ai.active_count(), 0);
}

#[test]
fn an_http_error_reports_the_status_and_the_servers_body() {
    let (base, _seen) = serve("401 Unauthorized", vec![send(r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#)]);
    let events = start(&ai_with(&[(Provider::Anthropic, "bad")]), plain("anthropic", &base)).all();
    assert_eq!(events, vec![AiEvent::Error { message: r#"HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.into() }]);
    // A long body is cut to 500 characters and an ellipsis.
    let (base, _seen) = serve("500 Internal Server Error", vec![Play::Send(vec![b'x'; 3000])]);
    let events = start(&ai_with(&[]), plain("ollama", &base)).all();
    assert_eq!(events, vec![AiEvent::Error { message: format!("HTTP 500: {}…", "x".repeat(500)) }]);
}

#[test]
fn a_server_that_goes_quiet_times_out_and_one_that_is_not_there_cannot_be_reached() {
    // Silent after the headers and one delta: the idle timeout (ai.timeoutSec), not a total cap.
    let (base, _seen) = serve("200 OK", vec![send("{\"message\":{\"content\":\"Hi\"},\"done\":false}\n"), Play::Hold]);
    let mut request = plain("ollama", &base);
    request.timeout_sec = 0.3;
    let events = start(&ai_with(&[]), request).all();
    assert_eq!(events, vec![AiEvent::Text { delta: "Hi".into() }, AiEvent::Error { message: "Network error: The request timed out.".into() }]);
    // A stream slower in total than the timeout, but never idle that long, is fine.
    let mut play = Vec::new();
    for _ in 0..6 {
        play.push(send("{\"message\":{\"content\":\"a\"},\"done\":false}\n"));
        play.push(Play::Pause(100));
    }
    play.push(send("{\"message\":{\"content\":\"\"},\"done\":true}\n"));
    let (base, _seen) = serve("200 OK", play);
    let mut request = plain("ollama", &base);
    request.timeout_sec = 0.4;
    let events = start(&ai_with(&[]), request).all();
    assert_eq!(summary(&events), ("aaaaaa".to_string(), vec![json!({"kind": "done", "stopReason": "end"})]));
    // Nothing listening.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let events = start(&ai_with(&[]), plain("ollama", &format!("http://127.0.0.1:{port}"))).all();
    assert_eq!(events, vec![AiEvent::Error { message: "Network error: Could not connect to the server.".into() }]);
}

#[test]
fn a_connection_dropped_mid_stream_gives_what_arrived_and_no_tool_call() {
    // The server closes after a text delta and half a tool call: 0.90.34 returns the reply it has.
    let (base, _seen) = serve("200 OK", vec![send("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Par\"}}\n\ndata: {\"type\":\"content_blo")]);
    let events = start(&ai_with(&[(Provider::Anthropic, "k")]), plain("anthropic", &base)).all();
    assert_eq!(events, vec![AiEvent::Text { delta: "Par".into() }, AiEvent::Done { stop_reason: StopReason::End }]);
}

#[test]
fn stop_ends_a_stream_with_done_cancelled_and_keeps_the_text_so_far() {
    let (base, _seen) = serve("200 OK", vec![send("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"text\":\"Thinking\"}}\n\n"), Play::Hold]);
    let ai = ai_with(&[(Provider::Anthropic, "k")]);
    let stream = start(&ai, plain("anthropic", &base));
    assert_eq!(stream.next(), AiEvent::Text { delta: "Thinking".into() });
    assert_eq!(ai.active_count(), 1);
    ai.cancel(&stream.id);
    assert_eq!(stream.all(), vec![AiEvent::Done { stop_reason: StopReason::Cancelled }]);
    assert_eq!(ai.active_count(), 0);
    // Stopping it again, or something that never was, does nothing.
    ai.cancel(&stream.id);
    ai.cancel("ai-0-nothing");
}

#[test]
fn stop_works_before_the_server_has_answered_at_all() {
    // The server takes the request and says nothing.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        let _ = tx.send(());
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut b = [0u8; 64];
        while matches!(stream.read(&mut b), Ok(n) if n > 0) {}
    });
    let ai = ai_with(&[]);
    let stream = start(&ai, plain("ollama", &base));
    rx.recv_timeout(Duration::from_secs(10)).unwrap();
    ai.cancel(&stream.id);
    assert_eq!(stream.all(), vec![AiEvent::Done { stop_reason: StopReason::Cancelled }]);
}

#[test]
fn each_request_has_its_own_id() {
    let ai = ai_with(&[]);
    let a = start(&ai, plain("anthropic", "http://127.0.0.1:9"));
    let b = start(&ai, plain("anthropic", "http://127.0.0.1:9"));
    assert_ne!(a.id, b.id);
    assert!(a.id.starts_with("ai-1-") && b.id.starts_with("ai-2-"), "{} {}", a.id, b.id);
    a.all();
    b.all();
}

#[test]
fn test_connection_end_to_end() {
    let (base, seen) = serve("200 OK", vec![send(r#"{"model":"llama3.2","message":{"role":"assistant","content":"pong"},"done":true}"#)]);
    let settings = crate::settings_schema::with_defaults(&serde_json::Map::new());
    let request = test_request(Provider::Ollama, base, "llama3.2".into(), &settings);
    let outcome = tauri::async_runtime::block_on(http::test_connection(&request, ""));
    assert_eq!(outcome, TestOutcome { ok: true, message: "Reply: pong".into() });
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "POST /api/chat HTTP/1.1");
    assert_eq!(seen.body["stream"], json!(false));
    assert_eq!(seen.body["messages"].as_array().unwrap().last().unwrap(), &json!({"role": "user", "content": "Say the single word: pong"}));
    assert_eq!(seen.body.get("tools"), None);
    // A failure is the error's sentence.
    let (base, _seen) = serve("404 Not Found", vec![send(r#"{"error":"model 'nope' not found"}"#)]);
    let request = test_request(Provider::Ollama, base, "nope".into(), &settings);
    let outcome = tauri::async_runtime::block_on(http::test_connection(&request, ""));
    assert_eq!(outcome, TestOutcome { ok: false, message: r#"HTTP 404: {"error":"model 'nope' not found"}"#.into() });
    let request = test_request(Provider::Openai, "https://api.openai.com/v1".into(), "gpt-4o-mini".into(), &settings);
    let outcome = tauri::async_runtime::block_on(http::test_connection(&request, ""));
    assert_eq!(outcome, TestOutcome { ok: false, message: "AI backend not configured: API key is required for OpenAI.".into() });
}

#[test]
fn model_discovery_end_to_end() {
    let (base, seen) = serve("200 OK", vec![send(r#"{"data":[{"id":"qwen2.5-14b-instruct"},{"id":"llama-3.1-8b-instruct"}]}"#)]);
    let models = tauri::async_runtime::block_on(http::discover_models(Provider::Lmstudio, &format!("{base}/v1/"), "")).unwrap();
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["llama-3.1-8b-instruct", "qwen2.5-14b-instruct"]);
    assert_eq!(seen.recv().unwrap().request_line(), "GET /v1/models HTTP/1.1");
    let (base, seen) = serve("403 Forbidden", vec![send("no")]);
    let err = tauri::async_runtime::block_on(http::discover_models(Provider::Anthropic, &base, "sk-ant")).unwrap_err();
    assert_eq!(err.to_string(), "HTTP 403: no");
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "GET /v1/models?limit=1000 HTTP/1.1");
    assert_eq!((seen.header("x-api-key"), seen.header("anthropic-version")), (Some("sk-ant"), Some("2023-06-01")));
}

// ── The P7 review ───────────────────────────────────────────────────────────────────────────────

#[test]
fn a_redirect_is_reported_and_the_key_is_not_carried_to_another_host() {
    let (elsewhere, seen_elsewhere) = serve("200 OK", vec![send(ANTHROPIC_STREAM)]);
    let status: &'static str = Box::leak(format!("302 Found\r\nLocation: {elsewhere}/v1/messages").into_boxed_str());
    let (base, seen) = serve(status, vec![]);
    let ai = ai_with(&[(Provider::Anthropic, "sk-ant-test")]);
    let events = start(&ai, conversation("anthropic", &base)).all();
    assert_eq!(seen.recv().unwrap().header("x-api-key"), Some("sk-ant-test"));
    assert!(matches!(events.as_slice(), [AiEvent::Error { message }] if message.contains("302")), "{events:?}");
    assert!(seen_elsewhere.recv_timeout(Duration::from_millis(300)).is_err(), "the redirect was followed");
}

#[test]
fn a_request_nobody_listens_to_any_more_is_stopped() {
    let first = ANTHROPIC_STREAM.split_inclusive("\n\n").take(4).collect::<String>();
    let (base, _seen) = serve("200 OK", vec![send(&first), Play::Hold]);
    let ai = ai_with(&[(Provider::Anthropic, "sk-ant-test")]);
    drop(start(&ai, conversation("anthropic", &base)));
    let began = std::time::Instant::now();
    while ai.active_count() > 0 {
        assert!(began.elapsed() < Duration::from_secs(5), "the request outlived its listener");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_line_that_never_ends_is_refused_and_an_address_in_an_error_hides_its_credentials() {
    let mut lines = Lines::default();
    assert!(lines.push(&vec![b'x'; stream::MAX_LINE_BYTES]).is_empty());
    assert!(!lines.overlong());
    lines.push(b"x");
    assert!(lines.overlong());
    assert_eq!(wire::without_userinfo("ftp://me:secret@host/models"), "ftp://host/models");
    assert_eq!(wire::without_userinfo("http://host/a@b"), "http://host/a@b");
    let err = wire::models_request(Provider::Openai, "ftp://me:secret@host/v1", "").unwrap_err().to_string();
    assert!(!err.contains("secret"), "{err}");
}

// ── The current model sets (2.1, ledger AI-201…) ────────────────────────────────────────────────

fn with_model(provider: &str, base_url: &str, model: &str) -> ChatRequest {
    let mut r = plain(provider, base_url);
    r.model = model.into();
    r
}

#[test]
fn temperature_goes_only_to_models_known_to_accept_it() {
    let sends = |provider: &str, base: &str, model: &str| wire::prepare(&with_model(provider, base, model), "k", true).unwrap().body.get("temperature").cloned();
    let anthropic = "https://api.anthropic.com";
    for model in ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-opus-4-5-20251101", "claude-opus-4-1-20250805", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"] {
        assert_eq!(sends("anthropic", anthropic, model), Some(json!(0.5)), "{model}");
    }
    for model in ["claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-mythos-5-2", "claude-opus-4-60", "my-proxy-model"] {
        assert_eq!(sends("anthropic", anthropic, model), None, "{model}");
    }
    let openai = "https://api.openai.com/v1";
    for model in ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4-turbo"] {
        assert_eq!(sends("openai", openai, model), Some(json!(0.5)), "{model}");
    }
    for model in ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.5", "o3", "o4-mini", "gpt-4.5-preview-x", "gpt-4oo"] {
        assert_eq!(sends("openai", openai, model), None, "{model}");
    }
    // Local servers take it as before.
    assert_eq!(sends("lmstudio", "http://localhost:1234/v1", "anything"), Some(json!(0.5)));
    assert_eq!(wire::prepare(&with_model("ollama", "http://localhost:11434", "llama3.2"), "", true).unwrap().body["options"]["temperature"], json!(0.5));
}

#[test]
fn current_claude_requests_carry_no_thinking_setting_and_no_forced_tool_choice() {
    let p = wire::prepare(&{
        let mut r = conversation("anthropic", "https://api.anthropic.com");
        r.model = "claude-opus-5-5".into();
        r
    }, "k", true)
    .unwrap();
    for field in ["thinking", "tool_choice", "temperature", "top_p", "top_k", "output_config"] {
        assert_eq!(p.body.get(field), None, "{field}");
    }
}

#[test]
fn the_refusal_fallback_is_asked_for_only_on_anthropics_api_for_the_models_that_have_it() {
    let prepared = |base: &str, model: &str, on: bool| {
        let mut r = with_model("anthropic", base, model);
        r.fallback = on;
        wire::prepare(&r, "k", true).unwrap()
    };
    let api = "https://api.anthropic.com";
    for model in ["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"] {
        for base in [api, "https://api.anthropic.com/", " https://api.anthropic.com "] {
            let p = prepared(base, model, true);
            assert_eq!(header(&p, "anthropic-beta"), Some("server-side-fallback-2026-07-01"), "{model} {base}");
            assert_eq!(p.body["fallbacks"], json!("default"), "{model}");
        }
        // The setting off: neither.
        let p = prepared(api, model, false);
        assert_eq!((header(&p, "anthropic-beta"), p.body.get("fallbacks")), (None, None), "{model}");
        // A proxy or another server: neither.
        let p = prepared("https://proxy.example.com", model, true);
        assert_eq!((header(&p, "anthropic-beta"), p.body.get("fallbacks")), (None, None), "{model}");
    }
    for model in ["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-4-6"] {
        let p = prepared(api, model, true);
        assert_eq!((header(&p, "anthropic-beta"), p.body.get("fallbacks")), (None, None), "{model}");
    }
    // The pane's request without the field (an older page) reads as off.
    let r: ChatRequest = serde_json::from_value(json!({"provider": "anthropic", "model": "claude-opus-5-5", "baseURL": api, "system": "", "messages": [], "maxTokens": 1, "temperature": 1, "timeoutSec": 1})).unwrap();
    assert!(!r.fallback);
    // Test Connection reads the setting, on by default.
    let defaults = crate::settings_schema::with_defaults(&serde_json::Map::new());
    assert!(test_request(Provider::Anthropic, api.into(), "claude-opus-5-5".into(), &defaults).fallback);
    let off = crate::settings_schema::with_defaults(json!({"ai.fallback.anthropic": false}).as_object().unwrap());
    assert!(!test_request(Provider::Anthropic, api.into(), "claude-opus-5-5".into(), &off).fallback);
}

/// A current Claude model's answer: an empty thinking block with its signature, text, a tool call.
const ANTHROPIC_THINKING_STREAM: &str = concat!(
    "event: message_start\n",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_2\",\"model\":\"claude-opus-5-5\",\"content\":[]}}\n\n",
    "event: content_block_start\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"EqQBCkYIBxgCKkB…\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ajout d’une file — 待ち行列 🚦\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"add_node\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"name\\\": \\\"S1\\\"}\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null}}\n\n",
    "data: {\"type\":\"message_stop\"}\n\n",
);

#[test]
fn an_anthropic_stream_with_thinking_shows_the_text_and_runs_the_tool_call() {
    let (text, rest, stop) = every_chunking(Provider::Anthropic, ANTHROPIC_THINKING_STREAM);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(rest, vec![json!({"id": "toolu_01", "name": "add_node", "input": {"name": "S1"}})]);
    assert_eq!(stop, StopReason::ToolUse);
    // Only thinking: still 0.90.34's empty-answer sentence (the model said nothing).
    let only = "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Hmm\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    assert_eq!(parse(Provider::Anthropic, &[only.as_bytes()]).1.unwrap_err().to_string(), "Response parse error: Anthropic stream ended without any content blocks.");
    // The whole reply (Test Connection): thinking skipped, text and tool calls read.
    let blocks = wire::parse_reply(Provider::Anthropic, br#"{"content":[{"type":"thinking","thinking":"","signature":"abc"},{"type":"text","text":"pong"}],"stop_reason":"end_turn"}"#).unwrap();
    assert_eq!(wire::test_sentence(&blocks), "Reply: pong");
}

#[test]
fn a_refusal_says_so_in_plain_words_and_runs_nothing() {
    let refused = concat!(
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Here is how\"}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"run_solver\",\"input\":{}}}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"This looks like an attack on a network.\"}}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );
    let (events, end) = parse(Provider::Anthropic, &[refused.as_bytes()]);
    assert_eq!(end.unwrap(), StopReason::Refusal);
    assert_eq!(
        events,
        vec![
            AiEvent::Text { delta: "Here is how".into() },
            AiEvent::Refused { category: Some("cyber".into()), explanation: Some("This looks like an attack on a network.".into()) }
        ]
    );
    // Declined before any output, with no details at all: still a refusal, not an empty-answer error.
    let bare = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":null}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    let (events, end) = parse(Provider::Anthropic, &[bare.as_bytes()]);
    assert_eq!((events, end.unwrap()), (vec![AiEvent::Refused { category: None, explanation: None }], StopReason::Refusal));
    // Test Connection: connected, and the sentence says the model declined.
    let reply = |body: &str| wire::parse_reply(Provider::Anthropic, body.as_bytes()).unwrap_err().to_string();
    assert_eq!(reply(r#"{"content":[],"stop_reason":"refusal","stop_details":{"category":"bio","explanation":null}}"#), "Claude declined to answer this request. (Category: bio.)");
    assert_eq!(reply(r#"{"content":[],"stop_reason":"refusal","stop_details":{"category":"cyber","explanation":"Not this one."}}"#), "Claude declined to answer this request. Not this one.");
    assert_eq!(serde_json::to_value(StopReason::Refusal).unwrap(), json!("refusal"));
}

#[test]
fn after_a_fallback_block_the_other_models_answer_is_kept_and_the_earlier_tool_call_dropped() {
    let stream = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"content\":[]}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Partial \"}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t_before\",\"name\":\"run_solver\",\"input\":{}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"fallback\",\"from\":{\"model\":\"claude-opus-5-5\"},\"to\":{\"model\":\"claude-opus-4-8\"}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer.\"}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":4,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t_after\",\"name\":\"get_network_summary\",\"input\":{}}}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );
    let (text, rest, stop) = every_chunking(Provider::Anthropic, stream);
    assert_eq!(text, "Partial answer.");
    assert_eq!(rest, vec![json!({"id": "t_after", "name": "get_network_summary", "input": {}})]);
    assert_eq!(stop, StopReason::ToolUse);
}

#[test]
fn thinking_blocks_are_removed_whole_and_all_of_them() {
    let mut body = json!({"messages": [
        {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "s1"}, {"type": "text", "text": "A"}, {"type": "tool_use", "id": "t", "name": "n", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]},
        {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "x"}]},
        {"role": "user", "content": [{"type": "text", "text": "More"}]}
    ]});
    assert!(wire::strip_thinking(&mut body));
    assert_eq!(
        body,
        json!({"messages": [
            {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "A"}, {"type": "tool_use", "id": "t", "name": "n", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]},
            {"role": "user", "content": [{"type": "text", "text": "More"}]}
        ]})
    );
    assert!(!wire::strip_thinking(&mut body));
    // The pane's history never holds a thinking block, so no request has one to send.
    let p = wire::prepare(&conversation("anthropic", "https://api.anthropic.com"), "k", true).unwrap();
    let mut b = p.body.clone();
    assert!(!wire::strip_thinking(&mut b));
    let sig = br#"{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}"#;
    assert!(wire::is_thinking_signature_error(400, sig));
    assert!(!wire::is_thinking_signature_error(401, sig));
    assert!(!wire::is_thinking_signature_error(400, br#"{"error":{"message":"max_tokens: too large"}}"#));
}

/// A server that answers `answers.len()` requests one after the other, then stops listening.
fn serve_many(answers: Vec<(&'static str, Vec<Play>)>) -> (String, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for (status_line, play) in answers {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let seen = read_request(&mut stream);
            let _ = tx.send(seen);
            let length = play.iter().map(|p| if let Play::Send(b) = p { b.len() } else { 0 }).sum::<usize>();
            let _ = stream.write_all(format!("HTTP/1.1 {status_line}\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes());
            for step in play {
                if let Play::Send(bytes) = step {
                    let _ = stream.write_all(&bytes);
                }
            }
            let _ = stream.flush();
        }
    });
    (base, rx)
}

#[test]
fn a_400_about_a_thinking_signature_is_retried_once_without_thinking() {
    let error = r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}"#;
    let (base, seen) = serve_many(vec![("400 Bad Request", vec![send(error)]), ("200 OK", vec![send(ANTHROPIC_THINKING_STREAM)])]);
    let ai = ai_with(&[(Provider::Anthropic, "k")]);
    let request = conversation("anthropic", &base);
    let events = start(&ai, request.clone()).all();
    assert_eq!(events.last(), Some(&AiEvent::Done { stop_reason: StopReason::ToolUse }));
    let (first, second) = (seen.recv().unwrap(), seen.recv().unwrap());
    let mut stripped = first.body.clone();
    wire::strip_thinking(&mut stripped);
    assert_eq!(second.body, stripped);
    // Once only: the same error twice is reported.
    let (base, _seen) = serve_many(vec![("400 Bad Request", vec![send(error)]), ("400 Bad Request", vec![send(error)])]);
    let events = start(&ai, conversation("anthropic", &base)).all();
    assert_eq!(events, vec![AiEvent::Error { message: format!("HTTP 400: {error}") }]);
    // Another 400 is not retried.
    let (base, seen) = serve_many(vec![("400 Bad Request", vec![send(r#"{"error":{"message":"bad model"}}"#)]), ("200 OK", vec![send(ANTHROPIC_THINKING_STREAM)])]);
    let events = start(&ai, conversation("anthropic", &base)).all();
    assert!(matches!(events.as_slice(), [AiEvent::Error { message }] if message.contains("bad model")), "{events:?}");
    seen.recv().unwrap();
    assert!(seen.recv_timeout(Duration::from_millis(200)).is_err(), "retried");
}

/// A Responses API stream: a reasoning item, text, two function calls (one with streamed arguments).
const RESPONSES_STREAM: &str = concat!(
    "event: response.created\n",
    "data: {\"type\":\"response.created\",\"sequence_number\":0,\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
    "event: response.output_item.added\n",
    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"gAAAAB…\"}}\n\n",
    "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"in_progress\",\"content\":[]}}\n\n",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":1,\"content_index\":0,\"delta\":\"Ajout d’une file — \"}\n\n",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":1,\"content_index\":0,\"delta\":\"待ち行列 🚦\"}\n\n",
    "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\",\"output_index\":1,\"content_index\":0,\"text\":\"Ajout d’une file — 待ち行列 🚦\"}\n\n",
    "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"Ajout d’une file — 待ち行列 🚦\",\"annotations\":[]}]}}\n\n",
    "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"add_node\",\"arguments\":\"\",\"status\":\"in_progress\"}}\n\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":2,\"delta\":\"{\\\"name\\\":\"}\n\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":2,\"delta\":\" \\\"S1\\\", \\\"rate\\\": 2.5}\"}\n\n",
    "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":2,\"arguments\":\"{\\\"name\\\": \\\"S1\\\", \\\"rate\\\": 2.5}\"}\n\n",
    "data: {\"type\":\"response.output_item.done\",\"output_index\":2,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"add_node\",\"arguments\":\"{\\\"name\\\": \\\"S1\\\", \\\"rate\\\": 2.5}\",\"status\":\"completed\"}}\n\n",
    "data: {\"type\":\"response.output_item.added\",\"output_index\":3,\"item\":{\"id\":\"fc_2\",\"type\":\"function_call\",\"call_id\":\"call_b\",\"name\":\"run_solver\",\"arguments\":\"\"}}\n\n",
    "data: {\"type\":\"response.output_item.done\",\"output_index\":3,\"item\":{\"id\":\"fc_2\",\"type\":\"function_call\",\"call_id\":\"call_b\",\"name\":\"run_solver\",\"arguments\":\"{}\",\"status\":\"completed\"}}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n\n",
    "data: {\"type\":\"response.output_text.delta\",\"output_index\":9,\"delta\":\"after the end\"}\n\n",
);

fn responses_items() -> Vec<Value> {
    vec![
        json!({"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "gAAAAB…"}),
        json!({"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "Ajout d’une file — 待ち行列 🚦", "annotations": []}]}),
        json!({"id": "fc_1", "type": "function_call", "call_id": "call_a", "name": "add_node", "arguments": "{\"name\": \"S1\", \"rate\": 2.5}", "status": "completed"}),
        json!({"id": "fc_2", "type": "function_call", "call_id": "call_b", "name": "run_solver", "arguments": "{}", "status": "completed"}),
    ]
}

#[test]
fn a_responses_stream_gives_text_then_the_items_to_replay_then_the_function_calls() {
    let (text, rest, stop) = every_chunking(Provider::Openai, RESPONSES_STREAM);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(
        rest,
        vec![
            json!({"kind": "replay", "replay": {"provider": "openai", "model": "", "items": responses_items()}}),
            json!({"id": "call_a", "name": "add_node", "input": {"name": "S1", "rate": 2.5}}),
            json!({"id": "call_b", "name": "run_solver", "input": {}}),
        ]
    );
    assert_eq!(stop, StopReason::ToolUse);
    // Text only, completed: `end`.
    let plain_text = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
    assert_eq!(parse(Provider::Openai, &[plain_text.as_bytes()]).1.unwrap(), StopReason::End);
    // Cut at the limit.
    let cut = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n";
    assert_eq!(parse(Provider::Openai, &[cut.as_bytes()]).1.unwrap(), StopReason::MaxTokens);
    // The whole limit spent on reasoning: said so, not "no content".
    let spent = "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"summary\":[]}}\n\ndata: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n";
    assert_eq!(
        parse(Provider::Openai, &[spent.as_bytes()]).1.unwrap_err().to_string(),
        "Response parse error: The reply reached the Max tokens limit before any text was written. Raise Max tokens in Settings ▸ AI Assistant."
    );
}

#[test]
fn a_responses_stream_reports_errors_and_refusals() {
    let err = |s: &str| parse(Provider::Openai, &[s.as_bytes()]).1.unwrap_err().to_string();
    assert_eq!(err("event: error\ndata: {\"type\":\"error\",\"code\":\"rate_limit_exceeded\",\"message\":\"Rate limit reached\",\"param\":null}\n\n"), "HTTP 0: Rate limit reached");
    assert_eq!(err("data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"The server had an error\"}}}\n\n"), "HTTP 0: The server had an error");
    assert_eq!(err("data: {\"type\":\"response.failed\",\"response\":{}}\n\n"), "HTTP 0: Unknown streaming error.");
    assert_eq!(err("data: {\"type\":\"response.completed\",\"response\":{}}\n\n"), "Response parse error: OpenAI stream ended with neither text nor function calls.");
    // Text given before the error stays given.
    let (events, end) = parse(Provider::Openai, &[b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\ndata: {\"type\":\"error\",\"message\":\"boom\"}\n\n"]);
    assert_eq!((events, end.unwrap_err().to_string()), (vec![AiEvent::Text { delta: "Par".into() }], "HTTP 0: boom".to_string()));
    // A refusal content part.
    let refusal = concat!(
        "data: {\"type\":\"response.refusal.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"I can't \"}\n\n",
        "data: {\"type\":\"response.refusal.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"help with that.\"}\n\n",
        "data: {\"type\":\"response.refusal.done\",\"output_index\":0,\"content_index\":0,\"refusal\":\"I can't help with that.\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
    );
    let (events, end) = parse(Provider::Openai, &[refusal.as_bytes()]);
    assert_eq!((events, end.unwrap()), (vec![AiEvent::Refused { category: None, explanation: Some("I can't help with that.".into()) }], StopReason::Refusal));
}

#[test]
fn a_whole_response_is_read_for_test_connection() {
    let reply = |body: &str| wire::parse_reply(Provider::Openai, body.as_bytes()).map(|b| wire::test_sentence(&b)).map_err(|e| e.to_string());
    assert_eq!(
        reply(r#"{"id":"resp_1","status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong","annotations":[]}]}]}"#).unwrap(),
        "Reply: pong"
    );
    assert_eq!(reply(r#"{"output":[{"type":"function_call","call_id":"c","name":"n","arguments":"{}"}]}"#).unwrap(), "Connected (no text returned).");
    assert_eq!(reply(r#"{"error":{"message":"no"}}"#).unwrap_err(), "Response parse error: Missing `output` array in OpenAI response.");
    assert_eq!(reply(r#"{"output":[{"type":"reasoning","summary":[]}]}"#).unwrap_err(), "Response parse error: OpenAI response had neither text nor function calls.");
    assert_eq!(reply(r#"{"output":[{"type":"message","content":[{"type":"refusal","refusal":"No."}]}]}"#).unwrap_err(), "The model declined to answer this request. No.");
    let blocks = wire::parse_reply(Provider::Openai, br#"{"output":[{"type":"function_call","call_id":"c","name":"n","arguments":"{\"a\":1}"}]}"#).unwrap();
    assert_eq!(blocks, vec![Block::Tool(ToolCall { id: "c".into(), name: "n".into(), input: json!({"a": 1}).as_object().unwrap().clone() })]);
}

/// The conversation's first assistant turn with the output items OpenAI gave for it.
fn replayed(model: &str) -> ChatRequest {
    let mut r = conversation("openai", "https://api.openai.com/v1");
    r.model = "gpt-6-astra".into();
    if let Message::Assistant { replay, .. } = &mut r.messages[1] {
        *replay = Some(Replay { provider: Provider::Openai, model: model.into(), items: vec![json!({"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "gAAAAB…"}), json!({"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "add_node", "arguments": "{}"})] });
    }
    r
}

#[test]
fn a_responses_turn_is_replayed_unchanged_to_the_model_that_wrote_it_and_rebuilt_otherwise() {
    let input = |r: &ChatRequest| wire::prepare(r, "k", true).unwrap().body["input"].as_array().unwrap().clone();
    let same = replayed("gpt-6-astra");
    assert!(wire::replays_items(&same));
    let items = input(&same);
    assert_eq!(items[1], json!({"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "gAAAAB…"}));
    assert_eq!(items[2], json!({"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "add_node", "arguments": "{}"}));
    assert_eq!(items[3], json!({"type": "function_call_output", "call_id": "call_1", "output": "Added station S1."}));
    // Another model, or the replay dropped: rebuilt from text and calls, with no item ids.
    let other = replayed("gpt-6-luna");
    assert!(!wire::replays_items(&other));
    let rebuilt = input(&other);
    assert_eq!(rebuilt[1], json!({"role": "assistant", "content": "Adding it."}));
    assert_eq!(rebuilt, input(&wire::without_replay(&same)));
    // Anthropic never sends another provider's items.
    let mut a = replayed("gpt-6-astra");
    a.provider = Provider::Anthropic;
    let body = wire::prepare(&a, "k", true).unwrap().body;
    assert!(!body.to_string().contains("rs_1"));
    // The pane's shape for it round-trips.
    let m: Message = serde_json::from_value(json!({"role": "assistant", "text": "", "toolCalls": [], "replay": {"provider": "openai", "model": "m", "items": [{"type": "reasoning"}]}})).unwrap();
    assert!(matches!(m, Message::Assistant { replay: Some(ref r), .. } if r.items.len() == 1));
    let m: Message = serde_json::from_value(json!({"role": "assistant", "text": "x", "toolCalls": []})).unwrap();
    assert!(matches!(m, Message::Assistant { replay: None, .. }));
}

#[test]
fn a_responses_stream_end_to_end_and_a_400_on_a_replay_is_retried_without_it() {
    let (base, seen) = serve("200 OK", dribble(RESPONSES_STREAM));
    let ai = ai_with(&[(Provider::Openai, "sk-test")]);
    let mut request = conversation("openai", &format!("{base}/v1"));
    request.model = "gpt-6-astra".into();
    let events = start(&ai, request.clone()).all();
    let (text, rest) = summary(&events);
    assert_eq!(text, "Ajout d’une file — 待ち行列 🚦");
    assert_eq!(rest[0], json!({"kind": "replay", "replay": {"provider": "openai", "model": "gpt-6-astra", "items": responses_items()}}));
    assert_eq!(rest.last(), Some(&json!({"kind": "done", "stopReason": "toolUse"})));
    let seen = seen.recv().unwrap();
    assert_eq!(seen.request_line(), "POST /v1/responses HTTP/1.1");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-test"));
    assert_eq!(seen.body, wire::prepare(&request, "sk-test", true).unwrap().body);
    assert_eq!(seen.body.get("temperature"), None);

    let (base, seen) = serve_many(vec![("400 Bad Request", vec![send(r#"{"error":{"message":"Item 'rs_1' is not valid."}}"#)]), ("200 OK", vec![send(RESPONSES_STREAM)])]);
    let mut request = replayed("gpt-6-astra");
    request.base_url = format!("{base}/v1");
    let events = start(&ai, request.clone()).all();
    assert_eq!(events.last(), Some(&AiEvent::Done { stop_reason: StopReason::ToolUse }));
    let (first, second) = (seen.recv().unwrap(), seen.recv().unwrap());
    assert!(first.body.to_string().contains("rs_1"));
    assert_eq!(second.body, wire::prepare(&wire::without_replay(&request), "k", true).unwrap().body);
}

#[test]
fn openai_model_lists_keep_text_models_with_the_flagships_first() {
    let body = r#"{"object":"list","data":[
        {"id":"text-embedding-3-large"},{"id":"gpt-4o-mini"},{"id":"gpt-6-luna"},{"id":"gpt-image-2.6-flare"},{"id":"gpt-realtime-2.1"},
        {"id":"gpt-4o-mini-tts"},{"id":"gpt-transcribe"},{"id":"whisper-1"},{"id":"dall-e-3"},{"id":"omni-moderation-latest"},{"id":"gpt-6-astra"},
        {"id":"gpt-live-1"},{"id":"gpt-6-cyber"},{"id":"gpt-3.5-turbo-instruct"},{"id":"babbage-002"},{"id":"o3"},{"id":"o4-mini"},{"id":"gpt-6.1-terra"},
        {"id":"gpt-6.1-sol"},{"id":"gpt-4o-audio-preview"},{"id":"gpt-4o-search-preview"},{"id":"gpt-5.5"},{"id":"chatgpt-4o-latest"},{"id":"tts-1"}
    ]}"#;
    assert_eq!(
        wire::parse_models(Provider::Openai, body.as_bytes()).unwrap(),
        ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "chatgpt-4o-latest", "gpt-4o-mini", "gpt-5.5", "o3", "o4-mini"]
    );
    // LM Studio's list is every model its server loads, as before.
    assert_eq!(wire::parse_models(Provider::Lmstudio, br#"{"data":[{"id":"text-embedding-nomic"},{"id":"qwen"}]}"#).unwrap(), ["qwen", "text-embedding-nomic"]);
}

#[test]
fn anthropics_model_list_is_read_page_by_page_with_display_names() {
    let page = wire::parse_model_page(Provider::Anthropic, br#"{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5","created_at":"2026-09-01T00:00:00Z"}],"has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}"#).unwrap();
    assert_eq!(page, wire::ModelPage { models: vec![ModelInfo { id: "claude-opus-5-5".into(), display_name: Some("Claude Opus 5.5".into()) }], next: Some("claude-opus-5-5".into()) });
    let last = wire::parse_model_page(Provider::Anthropic, br#"{"data":[],"has_more":false,"last_id":null}"#).unwrap();
    assert_eq!(last.next, None);
    assert_eq!(wire::models_page_url("https://api.anthropic.com/v1/models", None), "https://api.anthropic.com/v1/models?limit=1000");
    assert_eq!(wire::models_page_url("https://api.anthropic.com/v1/models", Some("claude-sonnet-4-6")), "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-4-6");
    assert_eq!(serde_json::to_value(&page.models).unwrap(), json!([{"id": "claude-opus-5-5", "displayName": "Claude Opus 5.5"}]));
    assert_eq!(serde_json::to_value(ModelInfo { id: "x".into(), display_name: None }).unwrap(), json!({"id": "x"}));

    let first = r#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"},{"id":"claude-fable-5-2","display_name":"Claude Fable 5.2"}],"has_more":true,"last_id":"claude-fable-5-2"}"#;
    let second = r#"{"data":[{"id":"claude-mythos-5-2","display_name":"Claude Mythos 5.2"},{"id":"claude-haiku-4-5"}],"has_more":false,"last_id":"claude-haiku-4-5"}"#;
    let (base, seen) = serve_many(vec![("200 OK", vec![send(first)]), ("200 OK", vec![send(second)])]);
    let models = tauri::async_runtime::block_on(http::discover_models(Provider::Anthropic, &base, "sk-ant")).unwrap();
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["claude-fable-5-2", "claude-haiku-4-5", "claude-mythos-5-2", "claude-opus-5-5"]);
    assert_eq!(models[2].display_name.as_deref(), Some("Claude Mythos 5.2"));
    assert_eq!(seen.recv().unwrap().request_line(), "GET /v1/models?limit=1000 HTTP/1.1");
    assert_eq!(seen.recv().unwrap().request_line(), "GET /v1/models?limit=1000&after_id=claude-fable-5-2 HTTP/1.1");
    // A server that says "more" with the same last id forever is asked once more, not for ever.
    let looping = r#"{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}"#;
    let (base, seen) = serve_many(vec![("200 OK", vec![send(looping)]), ("200 OK", vec![send(looping)]), ("200 OK", vec![send(looping)])]);
    let models = tauri::async_runtime::block_on(http::discover_models(Provider::Anthropic, &base, "sk-ant")).unwrap();
    assert_eq!(models.len(), 1);
    seen.recv().unwrap();
    seen.recv().unwrap();
    assert!(seen.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn test_connection_counts_a_declined_probe_as_connected() {
    let (base, _seen) = serve("200 OK", vec![send(r#"{"content":[],"stop_reason":"refusal","stop_details":{"category":null,"explanation":null}}"#)]);
    let settings = crate::settings_schema::with_defaults(&serde_json::Map::new());
    let request = test_request(Provider::Anthropic, base, "claude-opus-5-5".into(), &settings);
    let outcome = tauri::async_runtime::block_on(http::test_connection(&request, "k"));
    assert_eq!(outcome, TestOutcome { ok: true, message: "Claude declined to answer this request.".into() });
}

#[test]
fn the_new_events_cross_ipc_in_the_pages_shape() {
    let events = vec![
        AiEvent::Refused { category: Some("cyber".into()), explanation: None },
        AiEvent::Replay { replay: Replay { provider: Provider::Openai, model: "gpt-6-astra".into(), items: vec![json!({"type": "reasoning"})] } },
        AiEvent::Done { stop_reason: StopReason::Refusal },
    ];
    assert_eq!(
        serde_json::to_value(&events).unwrap(),
        json!([
            {"kind": "refused", "category": "cyber", "explanation": null},
            {"kind": "replay", "replay": {"provider": "openai", "model": "gpt-6-astra", "items": [{"type": "reasoning"}]}},
            {"kind": "done", "stopReason": "refusal"}
        ])
    );
}
