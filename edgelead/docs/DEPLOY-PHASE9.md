# Phase 9 — deploy

## Files

| Target | Files |
|---|---|
| Supabase | `schema-phase9.sql` |
| Render | `server.js` |
| Netlify | `header.js`, `admin.html`, `clients.html`, `content-plan.html`, `ig-report.html`, `ig-competitors.html`, `fb-audit.html`, `fb-report.html`, `fb-advisor.html`, `index.html` (all in `netlify-phase9.zip`) |

## Order — do not reorder

1. **Supabase → SQL Editor → run `schema-phase9.sql`.** Verify: `select engine, count(*) from user_engine_access group by 1` shows `meta_owned` and `content_plan`.
2. **Render → environment.**
   - Remove `GEMINI_MODEL` (or set `gemini-3.7-flash`). The old default `gemini-2.5-flash` is what returned 404.
   - `APP_VERSION=phase9`
   - `FRONTEND_URL=https://<your-netlify-site>` (post-OAuth redirect target)
   - `META_APP_ID`, `META_APP_SECRET` — from developers.facebook.com. Add `https://<render-host>/api/meta/oauth/callback` as a Valid OAuth Redirect URI on the app's Facebook Login settings. Until these are set, everything else works and the Connect button is disabled.
   - Optional: `GEMINI_MODEL_FALLBACKS`, `META_GRAPH_VERSION` (default `v24.0`), `META_MEDIA_LIMIT` (default 50).
   Deploy `server.js`. Render logs should show `gemini_pool` with the key count and `schema_ok`.
3. **Netlify → upload the zip contents**, hard-refresh (Ctrl+Shift+R).

## First checks (≈ $0)

- `GET /api/health` → `version: "phase9"`.
- Admin → Keys tab → Gemini key pool: add one or two free AI Studio keys. Model line shows `gemini-3.7-flash → gemini-3.8-flash → …`.
- Post Advisor → Generate drafts on the same room that failed. It must now produce drafts or say *why* in plain words (rate limited / model unavailable / no drafts survived the gate).
- Clients → New → save → "Use in header". Header pill shows the client.
- Content Plan → pick an existing Competitor Intel report → Build plan. Zero Apify credit; one Gemini call. Scorecard, formats and captions tabs fill even if the AI briefs fail.
- Clients → Meta connection → Connect (needs `META_*`). Log in as the Page admin. Back on the page: connection listed with the IG username. Pull owner data → a `meta_owned` report appears in the timeline. Rebuild the content plan → Owner view tab now has reach / saves / hidden winners.

## What the shared client sees

A member added by email sees the client's timeline and can open every report in it, and runs they start under that client land there too. Their own vaults stay private. Only the owner can add/remove members.

## Notes on Meta App Review

Read-only scopes only. While the app is in Development mode, only accounts listed as app testers/admins can connect — fine for you and your co-worker. To let arbitrary clients connect, submit `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights` for review with a screencast of the connect → pull flow. No publishing or messaging scopes are requested, which keeps the review light.
