# HOW TO — Connect the AI Assistant to Anthropic (Claude API)

## OVERVIEW

The AI Assistant pane (lower-right of the main window) can drive Qnet via natural language once it is connected to a large language model. This guide walks through configuring the Anthropic (Claude) backend. The settings live in Settings ▸ AI Assistant.

## STEP 1 — GET AN API KEY FROM ANTHROPIC

1. Open https://console.anthropic.com/ in a browser.
2. Sign in (create an account if needed).
3. In the left sidebar click "API Keys".
4. Click "Create Key", give it a label (e.g. "Qnet desktop"), and copy the key that appears. It starts with "sk-ant-...". You will not be able to view the key again after closing the dialog — copy it now.
5. Make sure the account has credit/billing configured. New accounts typically come with a small amount of free credit; otherwise add a payment method under "Billing".

## STEP 2 — OPEN THE SETTINGS PANE

Qnet  →  Settings…  (⌘ ,)  →  AI Assistant  (in the left sidebar)

## STEP 3 — FILL IN THE FIELDS

```
Show AI Assistant pane     ON  (the toggle at the top of the pane;
                               flip it off any time to hide the
                               pane and expand the shell)

Provider:                  Anthropic (Claude API)

Base URL:                  https://api.anthropic.com
                           Leave this alone unless you are
                           routing through a corporate proxy.
                           The client appends "/v1/messages"
                           automatically.

Model:                     claude-opus-5-5  (the default)
                           Open the list button beside the
                           field: it offers the current
                           models with no key and no refresh
                           (the list is dated):
                             Claude Opus 5.5   — recommended
                             Claude Fable 5.2  — most capable,
                                                 costs more
                             Claude Sonnet 5.5 — faster,
                                                 lower cost
                             Claude Haiku 5.5  — fastest,
                                                 lowest cost
                           and the older models Anthropic still
                           serves (Fable 5.1 and 5, Opus 5,
                           Sonnet 5, Opus 4.8 to 4.5, Sonnet
                           4.6, Haiku 4.5; Sonnet 4.5 is
                           deprecated and retires on 30
                           November 2026). Once a key is saved,
                           "Refresh model list" asks your
                           account which models it can use;
                           that list then replaces the built-in
                           one, and models the built-in list
                           does not know appear too. You can
                           always type a model id by hand.
                           A model you chose earlier is kept.
                           If it is one Anthropic has retired
                           (claude-3-..., claude-sonnet-4-
                           20250514 and the like), a note under
                           the field names its replacement.

API Key:                   paste the "sk-ant-..." key from
                           step 1. Click the eye button to confirm
                           you pasted correctly. The key is
                           stored in the macOS Keychain under
                           service "com.bnetgui.ai", account
                           "anthropic" — not in settings.json,
                           not in any plain-text file.

System prompt:             a short instruction the model sees
                           at the start of every turn. The
                           default ("You are an assistant
                           embedded in BNET...") is fine.
                           Customize if you want a different
                           tone or extra context.

Max tokens:                4096 is a reasonable default.
                           Raise it if you want longer
                           replies; lower it to cap cost.

Temperature:               Sent only to models that accept
                           it: Claude Opus 4.6, Sonnet 4.6,
                           Haiku 4.5 and older. Current models
                           (Fable 5.x, Opus 5.5, 5, 4.8 and
                           4.7, Sonnet 5.5 and 5, Haiku 5.5)
                           refuse a temperature, so Qnet sends
                           them none and the slider has no
                           effect there.

If Claude declines, let    ON by default. When a model declines
another Claude model       a request (a safety check can stop a
answer:                    harmless question about, say, network
                           security), Anthropic's server hands
                           the same request to another Claude
                           model, which answers in the same
                           reply. Applies to Claude Fable 5.2
                           and 5.1, Opus 5.5 and 5, and Sonnet
                           5.5, on https://api.anthropic.com
                           only (not through a proxy). Turn it
                           off and the pane says that the
                           request was declined instead.

Timeout (seconds):         60. Bump higher only if you see
                           frequent timeouts under load.
```

## STEP 4 — SAVE AND TEST

1. Click "Save".
2. Click "Test Connection". Qnet sends a one-shot "pong" probe. On success you will see: ✓ Reply: pong On failure you will see an error in red (see troubleshooting below).

## WHAT QNET SENDS

Each request goes to the Base URL plus "/v1/messages" with your key, the header anthropic-version: 2023-06-01, the model, Max tokens, the system prompt, the whole conversation of this tab (your messages, the replies, the tool calls and their results) and the list of Qnet's tools. Temperature goes only where the model accepts it (above). With the fallback on, a supported model's request also carries the header anthropic-beta: server-side-fallback-2026-07-01 and the field fallbacks: "default".

Qnet sends no thinking setting, so current models think as much as they need (adaptive thinking). Their thinking is not shown, and it is never sent back: Qnet rebuilds the system prompt for each request, so it sends every earlier turn without its thinking. If Anthropic still rejects a request over a thinking block's signature, Qnet removes every thinking block and tries once more.

When the model declines (stop reason "refusal"), the pane shows "The model declined to answer this request" with Anthropic's reason when it gives one, drops what it had started to write, and runs none of its tool calls.

## STEP 5 — USE IT

Close Settings and type a prompt into the AI Assistant pane at the bottom-right of the main window. Press Enter or click the Send button (the up arrow) to send.

Examples to try: "Summarize the current network."

- → The model calls get\_network\_summary and describes what it finds.

"Run a comparison."

- → The model calls run\_command(name=RunComparison) and the output appears in the Shell pane below.

Each tool call is a row in the transcript that names the tool the AI invoked and its arguments; click it to see the input and result.

## TROUBLESHOOTING

```
"AI backend not configured: API key is required..."
  The API key field is empty. Paste the sk-ant-... key and click
  Save before trying again.

"HTTP 401: ... authentication_error ..."
  The key is invalid or revoked. Generate a new key on the
  Anthropic console and paste it in.

"HTTP 404: ... not_found_error ... model"
  The model name you entered is not available to your account,
  or Anthropic has retired it. Pick one from the Model list
  (Refresh model list shows what your account can use), for
  example "claude-opus-5-5".

"HTTP 400: ... temperature ..." or "... top_p ..."
  A model Qnet does not know refused a temperature. Qnet sends
  none to the models it knows refuse it; a model whose id is
  not one of Anthropic's (a proxy's own name) is sent none too.

"The model declined to answer this request"
  Claude's safety check stopped the request. Rephrase it, turn
  on "If Claude declines, let another Claude model answer", or
  pick another model.

"HTTP 429: rate_limit"
  Too many requests in the last minute. Wait and retry, or
  switch to a cheaper/smaller model.

"HTTP 529: overloaded_error"
  Anthropic's servers are temporarily overloaded. Retry in a
  moment; nothing on your end is wrong.

"Network error: ..."
  No connectivity, DNS issue, or a corporate proxy blocking
  api.anthropic.com. Check your network; if behind a proxy,
  set Base URL accordingly.

Tool calls never happen
  All four backends (Anthropic, OpenAI, LM Studio, Ollama)
  speak the structured tools[] protocol. For OpenAI, make sure
  you picked a current model (gpt-6-astra, gpt-6.1-sol,
  gpt-6.1-terra, gpt-6-luna; see the OpenAI article). For LM Studio /
  Ollama, the loaded model itself must be tool-trained —
  Llama 3.1+, Qwen 2.5+, and recent Mistral instruct releases
  all work; older and sub-3B models reply in prose instead of
  emitting `tool_calls`. See the per-backend "How to connect"
  help for tool-capable model picks.
```

## SECURITY NOTES

- The API key lives in the macOS Keychain; you can inspect or delete it with Keychain Access (service: com.bnetgui.ai).
- Conversations are sent to Anthropic's API verbatim. Do not paste secrets, credentials, or confidential data into the AI Assistant unless you understand Anthropic's data-handling policy and are comfortable with it.
- The model can execute menu commands (run\_command). Review each tool-call row in the transcript to see what it did.
