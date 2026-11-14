# HOW TO — Connect the AI Assistant to LM Studio (local inference)

## OVERVIEW

LM Studio is a free desktop app (Mac / Windows / Linux) that downloads open-weights language models and serves them through an OpenAI-compatible HTTP endpoint. Pointing Qnet at LM Studio gives you a fully-local, offline AI Assistant — no API key, no per-token cost, no data leaves your machine.

Tool calls (get\_network\_summary, add\_node, run\_command, etc.) work against LM Studio PROVIDED the loaded model is tool-trained. Tool capability is per-model, not per-server: Llama 3.1+, Qwen 2.5+, and recent Mistral instruct releases reliably emit `tool_calls`; older or sub-3B models don't. If the assistant insists on describing tool steps in prose instead of invoking them, that's almost always a model-capability problem, not a Qnet config problem. Pick LM Studio when you want privacy, offline use, or to experiment with open-weights models.

## STEP 1 — INSTALL LM STUDIO

1. Download LM Studio from https://lmstudio.ai/ and install it like any other Mac app (drag to /Applications).
2. Launch LM Studio. The first launch downloads a runtime; let it finish before continuing.

## STEP 2 — DOWNLOAD A SUITABLE MODEL

Open the "Discover" tab (magnifying-glass icon in the left sidebar) and search for a model. What to pick:

- Format: GGUF (the only format LM Studio's CPU/Metal runtime loads). Most listings on the Discover tab are already GGUF.
- Type: an instruction-tuned chat model. Files with names containing "Instruct", "Chat", or "IT" are tuned to follow prompts; raw "base" models will just complete text and won't behave like an assistant.
- Size: pick the largest you can run comfortably given your Mac's unified memory. As a rule of thumb the model file should leave at least 4 GB of RAM free for the OS.

  ```
   8 GB Mac    →  3B-parameter model, Q4_K_M quant
                  (~2-3 GB on disk)
   16 GB Mac   →  7B / 8B model, Q4_K_M
                  (~4-5 GB on disk)
   32 GB Mac   →  13B / 14B model, Q5_K_M, OR a 32B model
                  at Q4_K_M (~18 GB on disk)
   64 GB+ Mac  →  70B model, Q4_K_M (~40 GB on disk)
  ```

- Concrete recommendations (all instruction-tuned, all known to chat well; pick the one whose size matches your Mac):

  ```
   Llama-3.1-8B-Instruct (Q4_K_M)         — solid all-rounder
   Qwen2.5-7B-Instruct  (Q4_K_M)          — strong reasoning
   Qwen2.5-14B-Instruct (Q4_K_M)          — better answers,
                                            needs 16 GB+
   Llama-3.3-70B-Instruct (Q4_K_M)        — closest to a
                                            frontier model,
                                            needs 64 GB+
  ```

- Quantization: "Q4\_K\_M" is the sweet spot for size vs. quality. Q5\_K\_M / Q6\_K are slightly better at the cost of more RAM. Avoid Q2 / Q3 — they degrade noticeably for chat.
- Context window: any modern instruct model has at least 8K tokens of context, which is plenty for the AI Assistant's prompts. Larger contexts cost more RAM at load time.

Click "Download" on the model card and wait for it to finish.

## STEP 3 — START THE LOCAL SERVER

1. Switch to the "Developer" tab (terminal-prompt icon in the left sidebar; older builds call this "Local Server").
2. At the top, choose the model you downloaded from the "Select a model to load" dropdown. Wait for the load to complete (LM Studio shows a green "Ready" badge).
3. Confirm the server settings:

   ```
   Server port:       1234   (LM Studio's default)
   CORS:              on     (harmless for local use)
   Just-in-time load: on     (auto-reloads if you switch
                             models; optional)
   ```

4. Click "Start Server" (or the green play button at the top of the panel). The endpoint banner reads:

   ```
   http://localhost:1234
   ```

   and "Reachable at" shows your machine's LAN IP.

Verify from a terminal that the server is alive:

```
curl http://localhost:1234/v1/models
```

You should see a JSON list with one entry whose "id" matches the name shown next to the loaded model in LM Studio.

## STEP 4 — POINT QNET AT LM STUDIO

Qnet  →  Settings…  (⌘ ,)  →  AI Assistant

```
Show AI Assistant pane     ON

Provider:                  LM Studio (local)

Base URL:                  http://localhost:1234/v1
                           This is the default. Qnet appends
                           "/chat/completions" automatically.
                           If you started LM Studio on a
                           different port, change 1234 to match.
                           To talk to LM Studio running on
                           another machine on your LAN, use that
                           machine's IP, e.g.
                           http://192.168.1.42:1234/v1.

Model:                     copy the EXACT model id shown in the
                           LM Studio Developer tab (it usually
                           matches the download folder name,
                           e.g. "qwen2.5-7b-instruct" or
                           "llama-3.1-8b-instruct"). The
                           placeholder "local-model" only works
                           if LM Studio's "Just-in-time load"
                           toggle aliases it for you.

SHORTCUT: click the "Refresh model list"
button next to the Model field to
probe LM Studio's /v1/models endpoint
and populate the dropdown with the
model ids it's currently serving. The
dropdown groups results under
"From Server" (live probe) and
"Recommended" (Qnet's curated list).
Note: LM Studio only reports models
that are actually LOADED in the Local
Server tab — if the dropdown comes
back empty, load a model and click
refresh again.

API Key:                   leave blank. LM Studio does not
                           require authentication on a
                           localhost server. (If you put
                           anything here, Qnet will send it as
                           a Bearer token; LM Studio ignores
                           it.)

System prompt:             the default is fine. With a smaller
                           local model you may want to add
                           explicit instructions like "Be
                           concise. Use plain text. Do not
                           emit code unless asked."

Max tokens:                4096 is fine. Smaller (1024-2048)
                           makes replies snappier on slower
                           hardware.

Temperature:               0.3-0.7. Smaller open-weights models
                           ramble at high temperature; drop to
                           0.3 if answers feel unfocused.

Timeout (seconds):         60 is enough for most replies on
                           Apple Silicon. Bump to 180+ if you
                           are running a 70B model on a Mac
                           with limited RAM (slow first token).
```

## STEP 5 — SAVE AND TEST

1. Click "Save".
2. Click "Test Connection". Qnet sends a one-shot "pong" probe. On success you will see: ✓ Reply: pong (Smaller models sometimes reply with extra words around "pong" — that still counts as a successful round-trip.)

## STEP 6 — USE IT

Type a prompt into the AI Assistant pane. The first reply is slower than subsequent ones because LM Studio has to warm the model into RAM and build a KV cache; after that, response time is steady.

Examples that work well in chat-only mode: "Explain in plain English how the spectral method computes steady-state means for a Brownian network." "I'm trying to model a 3-station tandem queue with feedback from station 3 back to station 1. What rate vector and routing matrix should I use?" "What's the difference between a finite-element solver and a linear-program solver for this kind of problem?"

## HOW TOOLS BEHAVE ON THIS BACKEND

Qnet sends the full tool catalog using the OpenAI Chat Completions tool schema (which LM Studio implements verbatim). The model decides whether to invoke a tool each turn; results are fed back as `role: "tool"` messages keyed by the assistant's original `tool_call_id`.

The user-visible behavior depends on the loaded model:

- Tool-trained models (Llama 3.1+, Qwen 2.5+, recent Mistral instruct, etc.) — full parity with the Anthropic / OpenAI backends. "Build me a 2-station tandem with a Poisson source" will trigger chained add\_node / add\_link calls and the network appears on the canvas.
- Older / smaller / non-instruct models — LM Studio still accepts the request, but the model lacks the training to emit `tool_calls`. It will reply in prose instead. Switch to a tool-capable model from STEP 2 if that happens.

Aggressive quantization (q2, q3) sometimes breaks the JSON formatting of tool-call arguments even on otherwise tool-capable models — re-download at q4\_K\_M or higher if you see malformed-arguments errors in the AI transcript.

## TROUBLESHOOTING

```
"Network error: Could not connect to the server"
  LM Studio's server is not running, or the port doesn't match.
  Reopen LM Studio's Developer tab and confirm the green "Server
  running on port 1234" banner is showing.

"HTTP 404: Cannot POST /v1/chat/completions"
  Base URL is wrong. The OpenAI-compatible path is "/v1" — make
  sure the URL ends in "/v1" (e.g. http://localhost:1234/v1),
  NOT "/v1/chat/completions" (Qnet appends that itself).

"HTTP 400: model 'local-model' not found"
  The placeholder model id doesn't match what is loaded. Copy
  the exact id from LM Studio's Developer tab into the Model
  field.

Test Connection succeeds but real prompts time out
  The model is probably swapping to disk. Pick a smaller model
  (e.g. drop from 14B → 7B), a smaller quant (Q5_K_M → Q4_K_M),
  or close other RAM-hungry apps.

Replies are gibberish or repeat themselves
  You loaded a base (non-instruct) model. Re-download a variant
  whose name contains "Instruct", "Chat", or "IT".

Replies are extremely slow on first token
  Normal cold-start cost — LM Studio loads weights on demand.
  Send one warm-up prompt right after starting the server, or
  enable "Keep model in memory" in LM Studio's settings.
```

## SECURITY / PRIVACY NOTES

- The conversation never leaves your machine. LM Studio writes no logs to the cloud and Qnet sends only to the URL you configured.
- If you bind LM Studio to 0.0.0.0 (or expose port 1234 across your network), anyone on that network can use your model. Keep it on localhost unless you specifically want LAN access.
- With a tool-capable model loaded, the AI can run the solver and analysis commands (run\_command), add/delete nodes, edit parameters, etc. Review the tool-call rows in the AI transcript so you see what the assistant did.
