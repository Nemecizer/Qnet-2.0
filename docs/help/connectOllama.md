# HOW TO — Connect the AI Assistant to Ollama (local inference)

## OVERVIEW

Ollama is a free, command-line-driven local inference server (Mac / Windows / Linux) that downloads open-weights models and exposes them on a localhost HTTP endpoint. Pointing Qnet at Ollama gives you a fully-local, offline AI Assistant — no API key, no per-token cost, no data leaves your machine.

Compared to LM Studio: Ollama has no GUI, runs as a background daemon (autostarts on macOS once installed), and uses a simpler "MODEL:TAG" naming scheme. LM Studio has a richer GUI for browsing and configuring models. Either backend reaches the same set of open-weights models — pick whichever fits your workflow.

Tool calls (get\_network\_summary, add\_node, run\_command, etc.) work against Ollama PROVIDED the loaded model is tool-trained. Tool capability is per-model, not per-server: Llama 3.1+, Qwen 2.5+, and recent Mistral instruct releases reliably emit `tool_calls`; older or sub-3B models don't. If the assistant insists on describing tool steps in prose instead of invoking them, that's almost always a model-capability problem, not a Qnet config problem.

## STEP 1 — INSTALL OLLAMA

Mac (recommended): download the .dmg from https://ollama.com/ and drag to /Applications. The first launch installs a launchd agent that starts the server automatically on every login.

Or via Homebrew:

```
brew install ollama
brew services start ollama
```

Verify the daemon is up from a terminal:

```
curl http://localhost:11434/api/tags
```

You should see a JSON object whose `models` array is empty (no models pulled yet) or lists previously-pulled models.

## STEP 2 — PULL A SUITABLE MODEL

Ollama identifies models by a `name:tag` pair. The tag specifies parameter count + quantization. Pull from the terminal:

```
ollama pull llama3.1:8b-instruct-q4_K_M
```

What to pick:

- Type: an instruction-tuned chat model (tag contains "instruct"). Raw base models behave like text completers, not assistants.
- Size: pick the largest you can run comfortably given your Mac's unified memory. Rule of thumb — leave at least 4 GB free for the OS.

  ```
   8 GB Mac    →  3B-parameter model, q4_K_M quant
   16 GB Mac   →  7B / 8B model, q4_K_M
   32 GB Mac   →  13B / 14B model, q5_K_M, OR a 32B model
                  at q4_K_M
   64 GB+ Mac  →  70B model, q4_K_M
  ```

- Concrete tool-capable picks (all instruction-tuned, all function-call-trained):

  ```
   llama3.1:8b-instruct-q4_K_M       — solid all-rounder
   qwen2.5:7b-instruct-q4_K_M        — strong reasoning
   qwen2.5:14b-instruct-q4_K_M       — better answers,
                                       needs 16 GB+
   llama3.3:70b-instruct-q4_K_M      — closest to a frontier
                                       model, needs 64 GB+
  ```

- Quantization: q4\_K\_M is the sweet spot for size vs. quality. q5\_K\_M / q6\_K are slightly better at the cost of more RAM. Avoid q2 / q3 for chat — degrades noticeably and breaks tool-call JSON output.

Check what you've pulled:

```
ollama list
```

## STEP 3 — VERIFY THE SERVER

The daemon listens on http://localhost:11434 by default. Confirm a chat request round-trips:

```
curl http://localhost:11434/api/chat -d '{
  "model": "llama3.1:8b-instruct-q4_K_M",
  "messages": [{"role": "user", "content": "say pong"}],
  "stream": false
}'
```

The first request after pulling a model is slow — Ollama warms weights into RAM on demand. Subsequent requests against the same model are fast.

## STEP 4 — POINT QNET AT OLLAMA

Qnet  →  Settings…  (⌘ ,)  →  AI Assistant

```
Show AI Assistant pane     ON

Provider:                  Ollama (local)

Base URL:                  http://localhost:11434
                           The default. Qnet appends "/api/chat"
                           automatically. To talk to Ollama
                           running on another machine on your
                           LAN, point at that machine's IP, e.g.
                           http://192.168.1.42:11434 (and
                           configure Ollama to bind to 0.0.0.0
                           — see https://github.com/ollama/ollama/blob/main/docs/faq.md).

Model:                     copy the EXACT name:tag from
                           `ollama list` (e.g.
                           llama3.1:8b-instruct-q4_K_M). The
                           tag matters — without it, Ollama
                           picks an arbitrary default.

API Key:                   leave blank. Ollama doesn't
                           authenticate localhost connections.

System prompt:             the default is fine. With a smaller
                           local model you may want to add
                           "Be concise. Use plain text. Call
                           tools when the user asks you to
                           modify the network."

Max tokens:                4096. Smaller (1024-2048) makes
                           replies snappier on slower hardware.

Temperature:               0.3-0.7. Smaller open-weights models
                           ramble at high temperature; drop to
                           0.3 if answers feel unfocused or
                           tool calls become sloppy.

Timeout (seconds):         60 is enough on Apple Silicon.
                           Bump to 180+ for 70B models on Macs
                           with limited RAM (slow first token).
```

## STEP 5 — SAVE AND TEST

1. Click "Save".
2. Click "Test Connection". Qnet sends a one-shot "pong" probe. On success you see: ✓ Reply: pong

## STEP 6 — USE IT

Type a prompt into the AI Assistant pane. With a tool-capable model loaded, all nine Qnet tools (get\_network\_summary, add\_node, delete\_node, add\_link, delete\_link, update\_node, update\_link, run\_command, read\_status) are available — same as the Anthropic / OpenAI backends — and so are the tools the assistant explains results with (see Asking the Assistant to Explain).

Examples that exercise the full surface: "Summarize the current network."

- → calls get\_network\_summary, replies in prose.

"Build me a 2-station tandem with a Poisson source rate=1.5 and exponential service rate=2 at both stations."

- → chained add\_node + add\_link calls, network appears on the canvas.

"Run a comparison."

- → run\_command(name=RunComparison) — output streams to the Shell pane.

## HOW TOOLS BEHAVE ON THIS BACKEND

Qnet sends the full tool catalog using Ollama's native `tools[]` schema. The model decides whether to invoke a tool each turn; results are fed back as `role: "tool"` messages.

Ollama's wire format differs from OpenAI's in two small ways Qnet handles internally:

- `tool_calls[]` entries don't carry call IDs — Qnet synthesizes UUIDs locally and matches results positionally.
- `arguments` is delivered as a parsed JSON object (not a string), so the tool dispatcher gets the exact same shape it would from Anthropic.

If the loaded model isn't tool-capable, Ollama still accepts the request but the model's response will lack `tool_calls` and read like "Sure, here's how you'd add a node…" instead of actually adding one. Switch to one of the picks listed in STEP 2 if that happens.

## TROUBLESHOOTING

```
"Network error: Could not connect to the server"
  The Ollama daemon isn't running. Try:
    brew services start ollama
  or relaunch the Ollama.app from /Applications.

"HTTP 404: model 'X' not found, try pulling it first"
  You typed a model name that hasn't been pulled. Run
  `ollama list` to see what's available, or
  `ollama pull <name>` to fetch.

Replies are gibberish or repeat themselves
  Probably a base (non-instruct) model. Pull a tag whose
  name contains "instruct".

Tool calls never happen even though the model SHOULD support them
  Some quantized model files lose tool-call reliability under
  aggressive quantization (q2 / q3). Re-pull at q4_K_M or
  higher. Also: a `system` prompt that says "Answer concisely"
  sometimes nudges the model away from emitting tool_calls;
  add an explicit "Use the provided tools when appropriate"
  clause.

First-token latency is multiple seconds
  Cold-start cost while Ollama loads weights. Set
  OLLAMA_KEEP_ALIVE=24h in launchctl to pin loaded models in
  RAM:
    launchctl setenv OLLAMA_KEEP_ALIVE 24h
  (then restart the Ollama daemon).

Replies are extremely slow throughout the conversation
  The model is paging weights from disk because there isn't
  enough free RAM. Pick a smaller model (8B → 3B) or a
  smaller quant.
```

## SECURITY / PRIVACY NOTES

- The conversation never leaves your machine. Ollama writes no logs to the cloud and Qnet sends only to the URL you configured.
- Default bind is localhost only. To enable LAN access you must explicitly set OLLAMA\_HOST=0.0.0.0 — be aware that anyone on that network can then use your model.
- With tool use enabled, the model can run the solver and analysis commands (run\_command), add/delete nodes, edit parameters, etc. Review the tool-call rows in the AI transcript so you see what the assistant did.
