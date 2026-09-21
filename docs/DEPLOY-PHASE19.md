# Deploy — phase 19

Completing the two-sided product: the employee analyst, monthly owner reports, the Meta manager
onboarding path, and a stable comparison set per client.

Read `DEPLOY-PHASE18.md` first if you are deploying from a clean state; this file is the delta.

## Deploy order — SQL, then server, then pages

The repo rule holds and matters this time: `assistant.html` calls `/api/meta/monthly` and
`/api/meta/inbox`, and `clients.html` calls `/api/meta/connections/:id/onboard`. Pages deployed
ahead of the server degrade quietly (each call is caught, the panel stays hidden) but the features
do nothing until the server catches up.

1. **SQL** — `sql/schema-phase19.sql`. Already applied live as migration
   `phase19_complete_two_sided_product`. Idempotent; safe to re-run.
2. **Server** — `server.js`. No new environment variables.
3. **Pages** — `frontend/`. One new file, `assistant.html`.

## What the SQL does

| Change | Why |
|---|---|
| `clients.competitors text[]`, `competitors_source`, `competitors_updated_at` | The comparison set, held on the client rather than retyped per run. A yardstick that moves between reports makes every comparison meaningless. |
| `idx_ai_conversations_user_client` | Assistant threads are now filed per client. The column shipped in phase 15 and had never been written to. |
| `idx_reports_meta_monthly` | Monthly reports are always read as "the months for this connection, newest first". |

No table is created and nothing is dropped. `meta_monthly` is a new `reports.report_type`, not a new
table, so it appears in timelines, share links and client scoping without teaching any of them about it.

## API delta

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/meta/inbox` | Every Page this login manages, with the client each is filed under. |
| `POST` | `/api/meta/connections/:id/onboard` | Creates a client **from** the Page. 409 if already filed. |
| `POST` | `/api/meta/monthly` | Queues a monthly report. 400 on a month that has not finished. |
| `GET` | `/api/meta/monthly` | Monthly reports in scope, newest month first. |
| `PUT` | `/api/clients/:id/competitors` | Sets the comparison set. Max 12 handles. |
| `POST` | `/api/clients/:id/competitors/discover` | Queues discovery. 400 if the client has no niche. |
| `POST` | `/api/assistant/ask` | **Changed**: now accepts `clientId` on the body and scopes the whole answer to it. |
| `GET` | `/api/assistant/conversations` | **Changed**: now takes `?client_id=`. With none, returns only threads that have no client. |

`get_monthly_report` is added to `ASSISTANT_TOOLS`, so the assistant can read a finished month and
rewrite it for whatever audience is asked for.

## Post-deploy checks

1. **The analyst exists.** Sign in as an employee, open **Workspace → Analyst**. The scope banner
   must name the selected client, or say "your own account" when none is selected.
2. **Scoping is real, not cosmetic.** Ask the same question with two different clients selected. The
   answers must differ, and neither may mention the other client. Then check
   `select client_id, title from ai_conversations` — every thread must carry the client it was
   started under.
3. **A month is a month.** `POST /api/meta/monthly` with the current month must be refused with 400.
   Last month must run. On the finished report, confirm `snapshot_date` is the **1st of the month
   reported**, not the day you pressed the button.
4. **The delta table is honest.** In the finished `report_json.deltas`, a metric with no previous
   month must be `kind: "no_baseline"` and a metric that grew from zero must be `kind: "new"` with
   `pct: null`. If you see a percentage against a zero baseline, `pctDelta` has regressed.
5. **Onboarding from Business Suite.** With a Meta login that manages at least one unfiled Page,
   the Clients page shows "Pages you manage". "Make this a client" must create a client whose
   `fb_page_id` and `ig_handle` came from Meta and not from typing, and must file the connection
   against it in the same step.
6. **Discovery stays in band.** Run "Find similar businesses" on a client with a niche. Every
   returned account must be between a third and three times the client's follower count. An account
   far outside that band means `comparableBand` is not being applied.
7. `node tests/phase19.test.js` — 45 tests, no network.

## Known limits — what is not finished

- **Lead-list resale packaging is still not built**, and deliberately so: it is held pending a legal
  decision on reselling scraped contact data (Meta ToS, GDPR/CCPA — `leads` holds email, phone and
  WhatsApp). The internal master list is built and working; only the packaging and export for sale
  is on hold.
- **Competitor discovery is Instagram-only** and searches public accounts. A search match is not a
  competitor, which is why the result is shown for review and saving it is a separate, deliberate
  action rather than automatic.
- **The monthly report has no ad data**, because Meta Insights at these scopes carries none. The
  narrative prompt is explicitly forbidden from recommending budgets, bids, audiences or targeting;
  if a monthly report ever suggests ad spend, that instruction has been lost.
- **Page-level Instagram monthly metrics depend on the account type.** Anything the Graph API
  refuses for a given account lands in `report_json.gaps` and is reported as missing rather than
  quietly treated as zero.
- **Everything from phase 18's known-limits list still applies** — no captcha by decision, one Render
  instance, estimated Apify cost constants.
