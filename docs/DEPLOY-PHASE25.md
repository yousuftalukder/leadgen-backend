# Deploy — phase 25

Moving rows of the use-case model from "built, never exercised" to "walked end to end" — and the one
production bug that walking them found.

**No SQL. No page changes.** Server: one behavioural fix. Tests: 29 new end-to-end checks.

## The bug — rate limits shared one bucket

`rateLimit()` kept a single module-level `Map` keyed by the caller id alone, so every limiter with
the same kind of key was one bucket:

- `readLimit` runs on every `/api/` request (240/min, per user) and `spendLimit` on job starts
  (6/min, per user). Same key, same bucket. **A user who had made six API calls in the last minute
  — one page load — had their next job start refused with 429 "Too many requests".**
- `publicLimit` (30/min, per IP), the assistant (12/min, per IP) and the sign-up password check
  (10/min, per IP) shared too. A dozen share-link opens from one office NAT locked the assistant for
  the whole office.

Each limiter now counts in its own namespace. The sweep that clears expired buckets is key-agnostic
and unchanged. Two use-case tests hold the line: ten reads then a job start must be refused by the
*client* rule (400), never the limiter; and a run's worth of public traffic from an address must not
429 the assistant from that address.

If anyone has reported "Too many requests" on starting a report after browsing for a minute, this
was it.

## What the new tests prove

| Rows now E2E | The walk |
|---|---|
| A2, A3, A4 | Admin creates an employee with one engine → they sign in and see exactly that → a grant added later shows on the next request → an ungranted engine is 403 at the route → a changed trial cap is enforced on the client's very next request |
| E8 | An unfiled Page arrives in the inbox → one step makes it a client with name, Page id and handle from Meta → the connection is filed → onboarding twice is 409 → a colleague is refused |
| E14 | A run is scheduled under its client → listed for its owner only → a stranger cannot pause it → owner pauses, deletes |
| E6 | A scraped bio beginning `=` leaves the CSV neutralised |
| E10, C4 | The assistant against a **scripted model**: the test reads every request the server sent and asserts the tool result held only the chosen client's reports, the prompt named the client and the scope, a thread will not take a turn about another client, threads list per client, a client account gets the owner register, and a failed model call reads as a failure rather than an answer |
| S4 | Rate limits do not bleed between routes |

The Gemini fake is a `fetch` stub installed before `server.js` loads: it answers model discovery and
returns whatever the test scripted for each `generateContent` call, and keeps every request body.
Scope is therefore proven by **what reached the model**, not by what the code meant to send.

## Post-deploy checks

1. Sign in, browse for a minute (open five or six pages), then start a report. It must start — or be
   refused for a reason that is not "Too many requests".
2. `npm test` — 316 checks across 11 files; `npm run audit` — 36.

## Known limits

- Engines that spend Apify credit are still not run inside any test. The assistant is the exception
  only because its one outside call is the model.
- `live-checks.js` still needs a second real account.
