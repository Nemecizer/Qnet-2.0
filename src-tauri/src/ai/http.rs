//! The requests themselves: one streamed chat turn, Test Connection's single non-streaming
//! message, and model discovery. Everything is async on Tauri's runtime; nothing blocks the main
//! thread. A Stop is honoured wherever the request is waiting (connecting, waiting for the first
//! byte, between chunks), and dropping the response closes the connection.

use std::error::Error as _;
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use super::stream::{Lines, Next, Parser};
use super::wire::{self, Prepared};
use super::{AiEvent, Cancel, ChatRequest, LlmError, ModelInfo, Provider, StopReason, Stopped, TestOutcome};

/// 0.90.34 read at most this much of a failed streaming response's body (`ensureStreamOK` stops
/// once it holds more than 4,096 bytes).
const ERROR_BODY_BYTES: usize = 4097;

fn client() -> Result<&'static reqwest::Client, LlmError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // No redirects: reqwest drops Authorization on a hop to another host but not Anthropic's
            // `x-api-key`, and an API endpoint has no reason to redirect. A 3xx is reported as it is.
            reqwest::Client::builder()
                .user_agent(concat!("Qnet/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| LlmError::Transport(e.clone()))
}

/// `ai.timeoutSec` as the request's idle timeout (URLRequest.timeoutInterval: the longest wait
/// for the next bytes, not a cap on the whole answer; AI-015).
fn idle_timeout(seconds: f64) -> Duration {
    Duration::from_secs_f64(if seconds.is_finite() && seconds > 0.0 { seconds.min(86_400.0) } else { 60.0 })
}

/// A transport failure in the words macOS used for it (NSURLError's descriptions).
fn describe(e: &reqwest::Error) -> String {
    let mut chain = String::new();
    let mut source = e.source();
    let mut deepest = e.to_string();
    while let Some(s) = source {
        deepest = s.to_string();
        chain.push_str(&deepest.to_lowercase());
        chain.push('\n');
        source = s.source();
    }
    if e.is_timeout() {
        "The request timed out.".into()
    } else if e.is_connect() {
        if chain.contains("dns error") || chain.contains("failed to lookup address") {
            "A server with the specified hostname could not be found.".into()
        } else {
            "Could not connect to the server.".into()
        }
    } else if e.is_body() || e.is_decode() {
        "The network connection was lost.".into()
    } else {
        deepest
    }
}

/// Waits for `work`, giving up on a Stop or after `idle` without a result.
async fn wait<T>(cancel: &Cancel, idle: Duration, work: impl Future<Output = Result<T, reqwest::Error>>) -> Result<T, Stopped> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Stopped::Cancelled),
        r = tokio::time::timeout(idle, work) => match r {
            Err(_) => Err(LlmError::Transport("The request timed out.".into()).into()),
            Ok(Err(e)) => Err(LlmError::Transport(describe(&e)).into()),
            Ok(Ok(v)) => Ok(v),
        },
    }
}

fn post(prepared: &Prepared) -> Result<reqwest::RequestBuilder, LlmError> {
    let mut builder = client()?.post(&prepared.url);
    for (name, value) in &prepared.headers {
        builder = builder.header(*name, value);
    }
    Ok(builder.body(prepared.body.to_string()))
}

/// One streamed turn (LLMStreaming.swift `sendStreaming`): text deltas go to `emit` as they
/// arrive, the tool calls when the stream has ended well; answers with the stop reason.
///
/// One retry, never more (new in 2.1): an Anthropic 400 about a thinking block's signature is sent
/// again with every thinking block removed (`wire::strip_thinking`; removing all of them is always
/// allowed), and an OpenAI 400 on a request that replayed output items is sent again with each
/// turn rebuilt from its text and calls (`wire::without_replay`).
pub async fn run_chat(request: &ChatRequest, key: &str, cancel: &Cancel, emit: &(impl Fn(AiEvent) + Send + Sync)) -> Result<StopReason, Stopped> {
    let mut prepared = wire::prepare(request, key, true)?;
    let idle = idle_timeout(request.timeout_sec);
    let mut retried = false;
    let mut response = loop {
        let mut response = wait(cancel, idle, post(&prepared)?.send()).await?;
        let status = response.status();
        if status.is_success() {
            break response;
        }
        let mut body = Vec::new();
        while body.len() < ERROR_BODY_BYTES {
            match wait(cancel, idle, response.chunk()).await? {
                Some(chunk) => body.extend_from_slice(&chunk),
                None => break,
            }
        }
        body.truncate(ERROR_BODY_BYTES);
        let code = status.as_u16();
        if !retried && code == 400 {
            let again = match request.provider {
                Provider::Anthropic if wire::is_thinking_signature_error(code, &body) => {
                    let mut p = prepared.clone();
                    wire::strip_thinking(&mut p.body);
                    Some(p)
                }
                Provider::Openai if wire::replays_items(request) => Some(wire::prepare(&wire::without_replay(request), key, true)?),
                _ => None,
            };
            if let Some(p) = again {
                retried = true;
                prepared = p;
                continue;
            }
        }
        return Err(wire::http_error(code, &body).into());
    };

    let mut lines = Lines::default();
    let mut parser = Parser::for_model(request.provider, &request.model);
    let mut events = Vec::new();
    let mut ended = false;
    while !ended {
        let Some(chunk) = wait(cancel, idle, response.chunk()).await? else { break };
        let whole = lines.push(&chunk);
        if lines.overlong() {
            return Err(LlmError::Transport("The server's reply is not a stream of lines (one line passed 8 MB).".into()).into());
        }
        for line in whole {
            let next = parser.line(&line, &mut events);
            events.drain(..).for_each(emit);
            if next? == Next::Ended {
                ended = true;
                break;
            }
        }
    }
    if !ended {
        if let Some(line) = lines.finish() {
            let next = parser.line(&line, &mut events);
            events.drain(..).for_each(emit);
            next?;
        }
    }
    drop(response);
    if cancel.is_cancelled() {
        return Err(Stopped::Cancelled);
    }
    let reason = parser.finish(&mut events)?;
    events.drain(..).for_each(emit);
    Ok(reason)
}

/// 0.90.34's non-streaming `send`: the whole reply's bytes, or its error.
async fn send_once(request: &ChatRequest, key: &str) -> Result<Vec<wire::Block>, LlmError> {
    let prepared = wire::prepare(request, key, false)?;
    let idle = idle_timeout(request.timeout_sec);
    let never = Cancel::default();
    let unstopped = |s: Stopped| match s {
        Stopped::Failed(e) => e,
        Stopped::Cancelled => LlmError::Transport("cancelled".into()),
    };
    let response = wait(&never, idle, post(&prepared)?.send()).await.map_err(unstopped)?;
    let status = response.status();
    let body = wait(&never, idle, response.bytes()).await.map_err(unstopped)?;
    if !status.is_success() {
        return Err(wire::http_error(status.as_u16(), &body));
    }
    wire::parse_reply(request.provider, &body)
}

/// Test Connection (SettingsView.swift `testConnection`): "Reply: …", "Connected (no text
/// returned)." or the error's sentence.
pub async fn test_connection(request: &ChatRequest, key: &str) -> TestOutcome {
    match send_once(request, key).await {
        Ok(blocks) => TestOutcome { ok: true, message: wire::test_sentence(&blocks) },
        // The server answered: the connection works, though the model declined the probe.
        Err(LlmError::Refused(m)) => TestOutcome { ok: true, message: m },
        Err(e) => TestOutcome { ok: false, message: e.to_string() },
    }
}

/// Refresh model list (`discoverModels`): a GET with a 10 s timeout. Anthropic's list is read
/// page by page (`limit=1000`, then `after_id=<last_id>` while `has_more`; new in 2.1), at most
/// `MAX_MODEL_PAGES` pages and never the same page twice.
pub async fn discover_models(provider: Provider, base_url: &str, key: &str) -> Result<Vec<ModelInfo>, LlmError> {
    const MAX_MODEL_PAGES: usize = 20;
    let (endpoint, headers) = wire::models_request(provider, base_url, key)?;
    let idle = Duration::from_secs(10);
    let never = Cancel::default();
    let unstopped = |s: Stopped| match s {
        Stopped::Failed(e) => e,
        Stopped::Cancelled => LlmError::Transport("cancelled".into()),
    };
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let url = if provider == Provider::Anthropic { wire::models_page_url(&endpoint, after.as_deref()) } else { endpoint.clone() };
        let mut builder = client()?.get(&url);
        for (name, value) in &headers {
            builder = builder.header(*name, value);
        }
        let response = wait(&never, idle, builder.send()).await.map_err(unstopped)?;
        let status = response.status();
        let body = wait(&never, idle, response.bytes()).await.map_err(unstopped)?;
        if !status.is_success() {
            return Err(wire::models_http_error(status.as_u16(), &body));
        }
        let page = wire::parse_model_page(provider, &body)?;
        models.extend(page.models);
        match page.next {
            Some(next) if after.as_deref() != Some(next.as_str()) => after = Some(next),
            _ => break,
        }
    }
    Ok(wire::sort_models(provider, models))
}
