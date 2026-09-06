# Phase 9 — clients, Meta owner data, content plan, Gemini pool

## A. Why the advisor failed
| Seen | Cause |
|---|---|
| `Too many requests` on first click | One free-tier `GEMINI_API_KEY` shared by every user and every engine; a burst 429 had nowhere to go. |
| `The strategy service returned 404` | Google retired `gemini-2.5-flash` for accounts without prior use, months before the published Oct 16 2026 shutdown. Server default was still 2.5-flash and 404 was never retried. |

Fix: default `gemini-3.7-flash`, fallback chain `3.8 → 3.6 → 3.5 → 3.5-lite`, 404/model-400 falls through the chain (dead model remembered 1 h), 3.x `thinkingLevel` config, and a key pool (D).

## B. Client workspace
`clients` + `client_members`; nullable `client_id` on reports, jobs, competitor_sets, fb_group_sets, fb_page_sets, fb_suggestions, campaigns. `clientAccess()` gates everything; list routes take `client_id` (membership scope) or fall back to the per-user rule; single-report reads honour membership. Header picker (`EL.clientId()`, `EL.clientBody()`, `EL.clientQuery()`), `clients.html` with timeline, sharing, Meta tab.

## C. Meta owner data
Read-only scopes. `meta_oauth_states`, `meta_connections` (tokens encrypted), `meta_snapshots`, `meta_media` (shortcode = join key to `posts`). Routes `/api/meta/status|oauth/start|oauth/callback|connections|sync|reports|report/:id`. Worker `meta_insights` (engine `meta_owned`, $0 Apify) with per-metric resilience; Page + Page posts + IG account + IG media insights + demographics; one Gemini call; `reports.report_type='meta_owned'`.

## D. Gemini key pool
`gemini_keys` (personal or shared). Order: own → pool (LRU, cooldowns skipped) → env. 429 → 90 s cooldown + next key; invalid → marked; per-request/per-job user context via AsyncLocalStorage so every existing call site benefits without signature changes. Routes `/api/gemini-keys` (+ `/reset`). Admin panel + header "AI key" modal.

## E. Content plan (engine `content_plan`, $0 Apify)
From stored `posts` rows: features → `igIndexPosts` → band. Cell = format × opening × length × topic; verdicts gap / double_down / stop / filler. Reels won/lost/average by hook, audio, aspect, hour, plays ratio; carousels by slides; stills by aspect. Caption flag lifts, length, hashtags, openings, topics. Owner layer joins `meta_media` by shortcode (`insights`), everything else `scraped` / `derived`; "how true is this" panel. Gemini writes briefs only inside supplied cells; predicted band computed server-side. `reports.report_type='content_plan'`, `source_report_ids`. Page `content-plan.html`.

## F. Delivered
`schema-phase9.sql`, `server.js` (phase9), `header.js`, `clients.html`, `content-plan.html`, `admin.html` (Gemini pool), six existing pages sending `clientId` + client-scoped vaults + `?report=` deep links.

## G. Not in this phase
Meta publishing / inbox / ads; private FB groups; IG comment & follower scrapers (Phase 10).
