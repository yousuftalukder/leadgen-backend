# Deploy — phase 31

The Owner Assistant is XpulseAI's, copied in whole: its database, its twice-daily read of Meta, its
chat with the nineteen SQL-backed tools, its figure panels, and its page. EdgeLead's part is the seam:
the client an employee onboarded here, and the Meta connection made here, feed it.

**SQL first** (`sql/schema-phase31-xp.sql`, already applied to the live database on 22 September 2026
as twelve migrations named `phase31_xp_p00 … p11`), then the server. **Four new dependencies**
(`@google/genai`, `axios`, `luxon`, `node-cron`); Render installs them on deploy, CI now runs
`npm install` before the suite. No new environment variable is required.

## What was copied, and where it lives

| XpulseAI | Here | Note |
|---|---|---|
| `migrations/0001 … 0028` (less the ones below) | `sql/schema-phase31-xp.sql` | Every table, view and index renamed with an `xp_` prefix (`xp_clients`, `xp_meta_assets`, `xp_account_metric_snapshots`, …); the `fn_*` functions keep their names. 32 tables, 8 views, 39 functions, RLS on every table |
| `src/ai/chat.js`, `src/ai/charts.js`, `src/ai/pricing.js` | `xp/ai/` | The chat, its tools, the persona, the panels — unchanged but for the table names |
| `src/ingest/sync.js`, `src/ingest/ads.js` | `xp/ingest/` | The warehouse read: absolute daily snapshots, closed days never rewritten, settlement, follower truth |
| `src/meta/*`, `src/time.js`, `src/security.js`, `src/apify.js`, `src/social/*`, `src/ops/alerts.js` | `xp/` | Graph client, timezones, token sealing, the rest |
| `src/testing/*`, `scripts/replay.js`, two fixtures | `xp/testing/`, `xp/scripts/`, `xp/fixtures/` | XpulseAI's own cassette harness, so the sync can be proven here without Meta |
| — | `xp/config.js` | **Seam.** XpulseAI's settings read from EdgeLead's environment: `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `SCHEDULER_ENABLED`. Every value can be overridden with an `XP_*` variable (`XP_DEFAULT_TZ`, `XP_CRON_SCHEDULE`, `XP_GEMINI_MODEL`, …) |
| — | `xp/index.js` | **Seam.** Provisioning, EdgeLead's access rules, the routes under `/api/xp/*`, the cron |
| `public/portal.js` (the chat part) | `frontend/client-assistant.html` | The streamed answer, the panels, the chips, recent chats with rename and delete; EdgeLead's styling and session |

## How the seam works

- **Provisioning.** An EdgeLead client with an active Meta connection becomes one `xp_clients` row
  (same id), one `xp_meta_connections` row per connection (`el_connection_id` remembers which), and a
  Facebook asset plus an Instagram asset per Page. The tokens EdgeLead sealed are opened with
  EdgeLead's key and sealed again with XpulseAI's routine, keyed by `APP_ENCRYPTION_KEY`. Runs at boot
  (20 seconds in), before every cron pass, on *Read my numbers now*, and on first use of the chat. It
  is idempotent.
- **Access.** A client account is its own business and never chooses; staff name a client and must
  be able to read it (`clientAccess`), and need editor rights to start a read. Admin sees every
  asset's health at `GET /api/xp/admin/health` and can start a pass over everyone.
- **The read.** XpulseAI's cron pair, 09:00 and 21:00 UTC (`node-cron`), governed by the same
  `SCHEDULER_ENABLED` switch as the rest. A first read backfills 90 days of account numbers and every
  post; it takes a few minutes and runs in the background. A client whose accounts are connected but
  not yet read is offered *Read my numbers now* on the Ask page.
- **The chat.** `POST /api/xp/chat/stream` streams `status`, `delta` and `done` events exactly as
  XpulseAI does; `POST /api/xp/chat` is the non-streaming fallback. A business with no active asset
  is answered 409 *Connect a Facebook Page and Instagram account first* and the model is never called.
  Conversations are per business: list, open (panels rebuilt from the stored tool results), rename,
  soft-delete.

## Seams inside the SQL (the three places the copy is not verbatim)

1. The check constraints on `xp_meta_connections.status` and `xp_sync_runs.run_type` carry
   auto-generated `xp_`-prefixed names here, so XpulseAI's 0020 and 0022 drop both spellings before
   re-adding them (otherwise `SUPERSEDED` and `ADS` would still be refused).
2. 0014 scoped two Instagram convention notes to Shaking Seafood's asset. That asset does not exist
   here and the notes describe that account's history, so they are **removed**, and the removal is
   logged in `xp_data_repairs`.
3. 0011-g derives the Facebook reach convention from data; this copy starts under the new
   measurement, so the `REACH_MEDIA_VIEWERS` note (in 0019's client wording) is seeded from
   2020-01-01 and logged as `el-0011g`.

## Deliberately not copied

XpulseAI's own staff and owner accounts (passkeys, sessions, mail — migrations 0025, 0027, 0029:
EdgeLead's accounts and Gmail do that), the data repairs for its own three clients (0015–0017), the
PDF monthly report (puppeteer), the ads OAuth flow (the ads tables exist and `get_ad_performance`
answers when ad data exists), and the Apify influencer ingestion (the tables exist; the tool answers
"none"). `assistant.html` — EdgeLead's own analyst for staff — is unchanged.

## Post-deploy checks

1. **SQL**: `select count(*) from xp_clients;` answers (0 until a client is provisioned);
   `select proname from pg_proc where proname = 'fn_period_bundle';` returns one row.
2. **Render logs** carry `xp_start` with `"enabled":true,"schedule":"0 9,21 * * *"` and, twenty
   seconds later, `[xp] provisioned {"clients":N,…}` — N is the number of EdgeLead clients with an
   active Meta connection.
3. **As a client whose business has a connection**: Ask shows *Your accounts are connected* and
   *Read my numbers now*; pressing it answers 202 and, a few minutes later, `GET /api/xp/status`
   shows `runs[0].status: "OK"` and coverage with `account_days > 0`. Then any starter question
   streams an answer with a figure panel.
4. **As a client with no connection**: Ask shows *Connect your Facebook Page and Instagram account
   first* with the link to My Reports.
5. `npm test` — 383 checks across 12 files, 126 walked flows; `npm run audit` — 38.
6. The sync itself, without Meta: `node xp/scripts/replay.js replay xp/fixtures/ig-shaking-seafood-salem-nh.json --twice --finalize`
   prints *IDEMPOTENT — the second run changed nothing* and *no finalized row was touched* (the seven
   cassette misses it reports are date windows that moved since the recording; XpulseAI's own copy
   reports the same seven today). The cassette is XpulseAI's private recording of a real account and stays out of this
   public repository: copy it from the XpulseAI checkout (fixtures/ig-shaking-seafood-salem-nh.json) into xp/fixtures/ first.

## Known limits

- **The first read is minutes, not seconds**, and the cron pair is twelve hours apart: numbers for a
  day are complete the next morning, and reach for a day is *verified* only once Meta has stopped
  changing it (settlement), which XpulseAI explains in every answer that needs it.
- **Instagram's insights timezone** is set to UTC and Facebook's to America/Los_Angeles per asset,
  as XpulseAI does; a client's own timezone (`clients.timezone`, new column) governs the dates in
  answers and defaults to `XP_DEFAULT_TZ` (Asia/Dhaka).
- **One key seals both.** XpulseAI's tokens in the `xp_*` tables are sealed with `APP_ENCRYPTION_KEY`;
  rotating it re-seals EdgeLead's rows through the existing rotation and the `xp_*` rows by
  re-provisioning (`POST /api/xp/admin/sync-all`).
- **The daily question limit** (`CHAT_DAILY_LIMIT`) is off unless set, as in XpulseAI.
