# Phase 76 — Edge Meta AI rides out an overloaded Gemini

## Run

There's no SQL. Deploy the server (Render does this by itself on merge).

Optional: **`GEMINI_FALLBACK_MODEL`** names the backup model. It defaults to `gemini-3.5-flash`; `none` turns the fallback off.

## Why

An owner asked "What are you working on for us?" and got "Something went wrong while reading your numbers". The server, the database and the keys were all fine. Google answered `503 UNAVAILABLE: "This model is currently experiencing high demand"` for `gemini-3.7-flash`. Every key gets the same answer from an overloaded model, so the chat gave up at once.

## What changed

- **Overloaded model:** a 503, `UNAVAILABLE` or "high demand" answer before any text was shown is waited out for 2 s and tried again on the same model.
- **Still overloaded:** the answer moves to the fallback model for the rest of its turns, and is tried once more there if needed.
- **Both overloaded:** the owner reads "The AI is busy right now. Please try again in a minute." instead of "Something went wrong while reading your numbers".
- **Which model answered** is saved with the message and printed in each `[chat] turn …` log line. Each overload is logged as `[chat] <model> overloaded`, and each switch as `[chat] answering with <fallback> instead of <model>`.

## Check after deploy

1. Ask Edge Meta AI anything. It answers.
2. When Google is busy, Render's log shows `answering with gemini-3.5-flash instead of gemini-3.7-flash` and the owner still gets an answer.
