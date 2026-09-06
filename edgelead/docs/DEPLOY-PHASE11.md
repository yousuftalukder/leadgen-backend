# EdgeLead — Phase 11 deploy: scheduled runs, share links, single-instance guard, IG extras, one source of truth

## What this phase delivers

| # | Item | What it is |
|---|---|---|
| 1 | **One source of truth** | This folder is the whole product: `server.js` (Phase 11), `frontend/` (all pages, Phase 10 contract + Phase 11), `sql/` (every migration), `docs/`, `tests/`, `scripts/`, `package.json`. The project used to hold a Phase 10 backend next to Phase 9 pages; that gap is closed. Put this folder in a Git repo before anything else (below). |
| 2 | **Scheduled runs** | `schedules` table + `POST/GET/PATCH/DELETE /api/schedules`, `POST /api/schedules/:id/run-now`. Poll every 60 s inside the job engine; compare-and-set claim on `next_run_at`; every guard a click gets (active owner, engine grant, client editor access, job slot, key can pay). New page `schedules.html`; "Repeat on a schedule" under every finished IG audit, Competitor Intel, FB Page and Community report; Automation tab on Clients. |
| 3 | **Share links** | `report_shares` table; `POST /api/share`, `GET /api/shares`, `DELETE /api/share/:id`; public `GET /api/public/share/:token` (per-IP limited, ownership fields stripped). Every report page opens `?share=<token>` with no sign-in, forms hidden. "Share link" button under every report; list + revoke on Clients → Automation. |
| 4 | **Single-instance guard** | Each server instance heartbeats into `system_settings`; a second live instance raises `multiple_instances` in the log, an admin alert, and `/api/health.instances.live > 1`. It does not make two instances safe — it makes the mistake visible within a minute. |
| 5 | **Live checks are a script** | `scripts/live-checks.js`: two real accounts against the real deployment; writes `docs/LIVE-CHECKS-<date>.md`. Certification is a file with a date, not a memory. |
| 6 | **IG expansion, the free three** | Bio contact extraction (email / phone / WhatsApp mined from bio and link fields, zero Apify cost) on audits and lead enrichment (`leads.whatsapp`). Reel **plays** kept apart from autoplay **views** (`posts.plays`, `distribution.plays`, `distribution.playback.medianPlaysPerView`). Lead Finder Method 1 takes a **place name** and resolves it through the search actor's place mode. |
| 7 | **Phase 10 frontend contract, now in the repo** | Client picker in the header bar; `EL.api` adds `clientId`/`client_id`; `currentClient / clientBody / clientQuery / reportParam`; `?report=` deep links on the five engine pages; Content Plan has Instagram / Facebook Page platform tabs, freshness table and provenance. |

Not changed: Apify cost constants remain estimates (the drift alarm still covers real spend). Per-process caches still require one Render instance — now enforced by alarm, not by memory.

## Deploy order — Git → SQL → Render env → server → Netlify. Do not reorder.

### 0. Git (once, five minutes, free)
```
cd edgelead
git init && git add -A && git commit -m "Phase 11"
# create a private repo on GitHub, then:
git remote add origin git@github.com:<you>/edgelead.git && git push -u origin main
```
From now on: edit here, commit, push, then deploy from this folder. Nothing else is a copy.

### 1. Supabase
Run `sql/schema-phase11.sql` in the SQL editor. Re-runnable. Verify:
```sql
select count(*) from public.schedules;
select count(*) from public.report_shares;
select column_name from information_schema.columns where table_name='posts' and column_name='plays';
```

### 2. Render env
- `APP_VERSION=phase11`
- `FRONTEND_URL=https://<your-netlify-site>` — **required** for share links to be absolute. Without it the URL is `/fb-report.html?share=…` (relative).
- Optional: `SCHEDULER_ENABLED=false` to disable the poll; `SCHEDULER_POLL_MS` (default 60000); `SHARE_DEFAULT_DAYS` (30); `SHARE_MAX_DAYS` (365); `SCHEDULE_MAX_PER_USER` (25).
- Render → Settings → **Instances = 1**. (The guard will shout if it is not.)

### 3. Server
Deploy `server.js` + `package.json` (Root directory = repo root; start command `npm start`). Boot log must show `phase11_ready` and **no** `schema_missing` for `posts.plays`, `leads.whatsapp`, `schedules.next_run_at`, `report_shares.token`.

### 4. Netlify
Deploy the `frontend/` folder (drag-and-drop, or connect the repo — the root `netlify.toml` sets `base = "frontend"`). Hard-refresh once: `header.js` is cached.

## API contract changes (server is the contract; pages conform)

- `GET /api/reports-history` rows now include `client_id`, `user_id`.
- `POST /api/schedules` `{ jobId | reportId, cadence: weekly|monthly, dayOfWeek 0–6, dayOfMonth 1–28, hourUtc 0–23, label }` → `201 { schedule }`. Only the caller's own finished jobs of a schedulable type (`ig_report`, `deep_audit`, `fb_community_audit`, `fb_page_report`, `meta_insights`).
- `GET /api/schedules[?client_id=]` → `{ schedules: [{ …, summary, mine }] }` (input omitted).
- `PATCH /api/schedules/:id` any of the above + `paused`. `DELETE /api/schedules/:id`. `POST /api/schedules/:id/run-now` → `202 { jobId }` or `402/409 { error, reason }`.
- `POST /api/share` `{ reportId, expiresDays, label }` → `201 { share, url }`. `GET /api/shares?report_id=|client_id=` → `{ shares: [{ …, active, url, reports:{…} }] }`. `DELETE /api/share/:id` revokes.
- `GET /api/public/share/:token` (no auth) → `{ report, client:{name,brand}|null, shared:{expiresAt,label,page} }`; `404` unknown/revoked, `410` expired.
- `GET /api/health` adds `instance`, `instances`, `scheduler`.
- IG audit payload: `main.whatsapp`, `main.contactSources`, `distribution.plays`, `distribution.playback`. Post rows: `plays`. Lead rows: `whatsapp`.
- Jobs carry `input.scheduleId` when started by a schedule; the schedule row records `last_job_id`, `last_report_id`, `last_status`, `last_error`.

## Behaviour to tell your co-worker about
- **Schedules run under the account that created them** and spend that account's key path (personal → engine primary → pool). Pause them before going on holiday if credit is tight; a skipped run for no credit records `skipped_no_credit` and alerts admin, and does not pile up parked jobs.
- **A share link is the whole credential.** Send it to the client only. Turn it off from the report page or Clients → Automation; the public page then says "This link has been turned off".
- A place name in Lead Finder Method 1 now works, but the search actor's place output has **not** been verified against live data — the first real run tells us. The job reports "no Instagram location matched" rather than guessing.

## Post-deploy checks (live)
Run once, with two accounts on a shared client:
```
BACKEND_URL=… SUPABASE_URL=… SUPABASE_ANON_KEY=… USER_A_EMAIL=… USER_A_PASSWORD=… USER_B_EMAIL=… USER_B_PASSWORD=… CLIENT_ID=… SPEND=1 node scripts/live-checks.js
```
Commit the `docs/LIVE-CHECKS-<date>.md` it writes. The 4-user certification is complete when that file says ALL PASSED. Then by hand:
1. Open a finished IG audit → **Share link** → open the URL in a private window → report renders, no header nav, no forms. Turn it off → private window reload says the link is off.
2. **Repeat on a schedule** → Schedules page lists it → **Run now** → the run appears on the client timeline; the schedule shows `last: started` then `done` with a **Last report** link.
3. Clients → Automation shows both.
4. `/api/health` → `instances.live` is 1.
5. Lead Finder Method 1 with `Rangpur` (no URL) → run notes say either "resolved to N location page(s)" or "no Instagram location matched". Report which — it is the one unverified path in this phase.
