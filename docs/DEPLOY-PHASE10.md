# EdgeLead — Phase 10 deploy: client-scoped post history, FB Page content plans, working client wiring

## What this phase fixes

| # | Problem (as found in the project files) | Fix |
|---|---|---|
| 1 | Content Plan read `posts` by `user_id` only — a teammate's Competitor Intel on a shared client was invisible | Reads own vault **plus** rows any member filed under the selected client; same post deduped, newest scrape wins; other clients never read |
| 2 | `posts`, `fb_posts`, `fb_page_posts` had no `client_id` (every other artefact table got it in Phase 9) | `schema-phase10.sql` adds the column, indexes, and a re-runnable backfill; every post write path now stamps it |
| 3 | Content Plan was Instagram-only despite the generic name | Facebook Pages are a first-class platform: `fb_page_posts` → same cell scoring, own format set (Video / Photo / Album / Link / Text), FB owner Insights layer (reach, engaged, clicks, shares) |
| 4 | Rows from months ago were scored as if current | Freshness measured per handle; >45 days raises a warning, prints in "How true is this", and is passed to Gemini so the summary says so |
| 5 | **No engine page sent `clientId`** — every report saved with `client_id = null`, client timeline always empty | `header.js` renders a client picker in the header bar on every page; `EL.api` adds `clientId` to POST bodies and `client_id` to GET queries automatically |
| 6 | `content-plan.html` called `EL.currentClient()`, `EL.clientBody()`, `EL.clientQuery()` which did not exist → page threw on load | Helpers added to `header.js` (plus `EL.reportParam()`) |
| 7 | Client timeline linked to `page.html?report=<id>` but no engine page handled it | Deep links on `ig-report`, `ig-competitors`, `fb-report`, `fb-audit`, `content-plan` |

Not fixed (stated, not hidden): Apify cost constants remain unvalidated — needs real ledger rows. Per-process caches still break under >1 Render instance — needs a shared store; separate piece of work.

## Deploy order — SQL → Render env → server → Netlify. Do not reorder.

### 1. Supabase
Run `schema-phase10.sql` in the SQL editor. Re-runnable. Then verify:
```sql
select count(*) filter (where client_id is not null) stamped, count(*) total from public.posts;
select count(*) filter (where client_id is not null) stamped, count(*) total from public.fb_page_posts;
```
Rows without a client-filed report stay `null` — expected; they remain readable through the user's own vault.

### 2. Render env
- `APP_VERSION=phase10`
- optional: `CONTENT_PLAN_STALE_DAYS` (default 45), `CONTENT_PLAN_POSTS_PER_HANDLE` (default 120)

### 3. Server
Deploy `server.js`. Boot log must **not** show `schema_probe_missing` for `posts.client_id`, `fb_page_posts.client_id`, `fb_posts.client_id`. If it does, step 1 did not run — post upserts will fail on the unknown column until it does.

### 4. Netlify
Upload the zip: `header.js`, `content-plan.html`, `ig-report.html`, `ig-competitors.html`, `fb-report.html`, `fb-audit.html`. Hard-refresh once (header.js is cached).

## API contract changes (server is the contract; pages conform)

`POST /api/content-plan`
- new `platform`: `"instagram"` (default) | `"facebook"`. Inferred from `reportId` when omitted (`fb_page` → facebook).
- `target` / `rivals`: IG handles, or FB page URLs/slugs (parsed by `parsePageRef`).
- `counts`: `{ reels, carousels, stills }` or `{ videos, photos, albums, links, texts }`. Flat keys still accepted.
- `clientId`: added automatically by `EL.api`.

`GET /api/content-plans` — no longer filtered to instagram; rows carry `platform`.

`GET /api/content-plan/sources` — includes `fb_page` reports; with `?client_id=` returns the client's reports OR the caller's own; each row has `platform` and `mine`.

Report row for a plan: `platform` is now `instagram` | `facebook`; FB plans fill `fb_page_ids` / `fb_page_names` and store the page display name in `target_handle`.

Payload additions in `report_json`: `platform`, `formatSpec`, `targetName`, `rivalNames`, `names`, `freshness`, `trueness.freshness`, `trueness.provenance`, `owner.topReach`. Plans saved before Phase 10 have none of these and still render (page defaults to the IG spec).

## Behaviour changes to tell your co-worker about
- The client picker is now in the header bar. Whatever is selected there is where every run is filed and which vault every page lists. "None (just me)" = the old per-user behaviour. Changing it reloads the page.
- Adding a group by hand on the Communities page now files the probe rows under the selected client; if you are only a *viewer* on that client you will get a 403 — pick "None" or ask for editor.
- Content Plan on a client shows a **Provenance** row: how many rows came from teammates. It never reads across clients.

## Post-deploy checks (live)
1. Select a client, run an IG audit on a handle → `select client_id from posts where handle='…' order by scraped_at desc limit 1` is that client.
2. As the *other* member of that client, open Content Plan → the audit appears in "Start from an existing report" marked `· teammate`; building a plan shows teammate rows in Provenance.
3. Switch platform to Facebook Page, pick an FB Page Report → plan renders with Videos/Photos/Albums/Link/Text tabs.
4. Open a plan saved before this deploy → still renders (Reels/Carousels/Stills).
5. Clients page → click a timeline row → the engine page opens that report.
6. Run a plan on a handle last audited >45 days ago → stale warning at the top, red age in "How true is this".
