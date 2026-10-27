# Phase 74 — Edge Meta AI answers instead of "Thinking…" for two minutes

## Run

There's no SQL.

1. On Render, set **`GEMINI_THINKING_LEVEL`** = `low`.
2. Deploy the server (Render does this by itself on merge).

## Why

Asking Edge Meta AI "What are you working on for us?" showed "Thinking…" for two minutes, then failed. Render logged `The answer ran past its deadline` after 120 s. The first call to Gemini (`gemini-3.7-flash`, with no cap on thinking) never sent anything back, so the whole answer's deadline ran out.

## What changed

- **Thinking cap:** `GEMINI_THINKING_LEVEL=low` caps how long the model thinks before it calls a tool or answers. Narrating figures a tool already worked out does not need long reasoning. The setting already existed and was not set.
- **Stalled calls:** a Gemini call that has sent nothing after 45 s is dropped.
  - The next key in the pool gets the turn, and the dropped key is not benched for it.
  - With no key left, the owner reads "The AI is slow to respond right now. Please ask again in a moment."
- **Logging:** every model turn is logged as `[chat] turn <ms> · <tool or answer> · thinking <tokens> tok`, and a failed key as `[chat] key n/N … failed: …`. A slow answer can now be traced in Render's log.

## Check after deploy

1. Ask Edge Meta AI "What are you working on for us?". The answer starts within seconds.
2. In Render → Logs, the `[chat] turn …` lines show each call's time.
