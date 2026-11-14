# HOW TO — Connect the AI Assistant to OpenAI

## OVERVIEW

The AI Assistant pane can work with OpenAI's GPT models. This guide walks through configuring the OpenAI backend. The settings live in Settings ▸ AI Assistant.

## STEP 1 — GET AN API KEY FROM OPENAI

1. Open https://platform.openai.com/ in a browser and sign in (create an account if needed).
2. Open "API keys" and click "Create new secret key". Give it a name (e.g. "Qnet desktop") and copy the key, which starts with "sk-". It is shown only once.
3. Make sure the account or project has billing set up; API use is billed separately from a ChatGPT subscription.

## STEP 2 — FILL IN THE FIELDS

Qnet  →  Settings…  (⌘ ,)  →  AI Assistant

```
Provider:                  OpenAI

Base URL:                  https://api.openai.com/v1
                           Leave this alone unless you route
                           through a proxy. Qnet appends
                           "/responses" (and "/models" for
                           the model list).

Model:                     gpt-6-astra  (the default)
                           The list button beside the field
                           offers the current models with no
                           key and no refresh (the list is
                           dated):
                             GPT-6 Astra   — most capable
                             GPT-6.1 Sol   — near-Astra, lower
                                             cost
                             GPT-6.1 Terra — fast, efficient
                             GPT-6 Luna    — most efficient
                           Once a key is saved, "Refresh model
                           list" asks your account which models
                           it can use. Only text models are
                           listed (embedding, audio, image,
                           realtime, transcription, speech,
                           moderation and search models are
                           left out), the current ones first.
                           You can always type a model id.
                           A model you chose earlier is kept.

API Key:                   paste the "sk-..." key. It is stored
                           in the macOS Keychain under service
                           "com.bnetgui.ai", account "openai",
                           never in settings.json.

Max tokens:                The longest reply, thinking included.
                           Reasoning models think before they
                           write: if a reply stops with nothing
                           written, raise it (8192 or more).

Temperature:               Sent only to GPT-4o and GPT-4.1
                           models (and older GPT-4 and GPT-3.5).
                           Current GPT models are reasoning
                           models and are sent none.
```

Then click "Test Connection". On success you will see "Reply: pong".

## WHAT QNET SENDS

Qnet uses OpenAI's Responses API: each request goes to the Base URL plus "/responses" with your key as a Bearer token. It carries the model, the system prompt as "instructions", the whole conversation of this tab as input items (your messages, the replies, each tool call as a function\_call item and each result as a function\_call\_output item), Qnet's tools as function tools, and Max tokens as max\_output\_tokens. No reasoning effort is set, so each model uses its own default.

Each request is sent with store: false and with the whole conversation, so OpenAI is not asked to keep the conversation for later. A reasoning model's reasoning comes back encrypted with each reply; Qnet keeps it with that reply, in memory only, and passes it back unchanged when it asks the same model to go on after a tool call, as OpenAI asks. If you switch model, earlier replies are sent as plain text and tool calls instead. If OpenAI rejects a request that carried kept reasoning, Qnet sends it once more without it.

When the model declines, the pane says "The model declined to answer this request" with the model's own words, and runs none of its tool calls.

LM Studio, which imitates OpenAI's older Chat Completions API, is not affected: it is still sent "/chat/completions" requests (see the LM Studio article).

## TROUBLESHOOTING

```
"AI backend not configured: API key is required for OpenAI."
  Paste the key and click Save Key.

"HTTP 401: ... invalid_api_key ..."
  The key is wrong or revoked. Create a new one.

"HTTP 404: ... model ... does not exist"
  Your account cannot use that model. Refresh the model list
  and pick one from "Available to Your Account".

"HTTP 429: ... insufficient_quota" or "rate_limit_exceeded"
  Add billing or wait a moment, or pick a smaller model.

"The reply reached the Max tokens limit before any text was
 written."
  The model spent the whole limit thinking. Raise Max tokens.
```

## SECURITY NOTES

- The API key lives in the macOS Keychain (service com.bnetgui.ai); Keychain Access can show or delete it.
- Conversations are sent to OpenAI's API. Do not paste secrets or confidential data into the AI Assistant unless OpenAI's data-handling terms suit you.
- The model can run solvers and change the canvas through its tools. Review each tool-call row in the transcript to see what it did.
