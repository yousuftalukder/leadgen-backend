# EdgeLead — Phase 12–18 deploy: two-sided product, owner assistant, Facebook leads, brand front end

This covers every change since Phase 11 in one document, because they ship together. Phases 12
through 18 were built in sequence but there is one deploy.

## What this delivers

| # | Item | What it is |
|---|---|---|
| 1 | **The schema matches the code again** | Phase 3 created `leads` / `campaigns` / `campaign_leads` with `if not exists` guards over tables that already existed by hand, so its definitions were never applied and drifted from reality. `sql/` could not rebuild a working database. `schema-phase12.sql` reconciles them, drops a duplicate unique constraint on `campaign_leads`, removes two RLS policies no migration declared, and closes the one ERROR-level security finding (three `SECURITY DEFINER` views readable with the published anon key). |
| 2 | **Accounts, trial and quota** | `app_users` gains a lifecycle (`trial_started_at`, `trial_ends_at`, `paid_until`, `activated_by`, `activated_at`, `plan_label`) and a new role, `client`. `usage_counters` + `usage_limits` are the quota ledger; `el_quota_consume` / `el_quota_release` are the atomic gate. **There is no `account_state` column** — state is derived from time by `el_account_state()`, so a trial expires on its own with nothing scheduled to expire it. |
| 3 | **Self-serve signup** | Signup happens in the browser via `supabase.auth.signUp()`, because that is what sends the confirmation email — and email confirmation is the main defence against trial-farming on the shared Apify pool. The server's hook is `ensureProfile()`: reaching its "no profile row" branch means nobody provisioned the account, which is the signature of self-serve, so it mints a `client` on a trial with the `TRIAL_ENGINES` grants. |
| 4 | **Leaked-password checking, ours** | Supabase's HIBP check is Pro-plan only. `POST /api/public/signup/password-check` does the same k-anonymity lookup (SHA-1, first five hex characters sent, remainder matched locally). Fails open. Advisory by nature; Supabase still enforces minimum length underneath. |
| 5 | **Client surface** — all four report types | `client.html`, `client-assistant.html`, `client-leads.html`, `client-community.html`. `clientReportView()` reads the same report row the employee view does and chooses different words — the raw score never reaches a client, only the letter grade. `/api/client/*` are separate endpoints that never select credits, set ids or source report ids. Content plans come through as numbered things to make (hook, script, shot, caption, boost call); community audits as the rooms worth being in. Cell keys, predicted indices and room-value scores never leave the server. |
| 6 | **Owner assistant** | `ai_conversations` + `ai_messages`. Seven bounded tools over the account's own data; the model never writes SQL and scope is resolved server-side, so no argument it invents can widen it. Two tiers: without Meta it sees only outside-visible data and says so once; with Meta it reads `meta_snapshots`, which costs no Apify. |
| 7 | **Facebook lead generation** | `fb_lead_discovery` worker + `POST /api/fb/find-leads`. Leads come from **Pages, never groups** — the group pipeline hashes author identity one-way by design. `leads` gains `platform` / `platform_id` and the unique key it has been missing since phase 3. |
| 8 | **Content plan: script, shot, boost, human findings** | Briefs carry `script` and `shot` (makeable by one person with a phone) and a boost call. `cpBoostCall()` enforces that only a `why=double_down` cell may be recommended for spend. `content_plan_notes` holds manual research as a third source, never folded into a computed index. |
| 9 | **Front end: brand, speed, shell** | Re-themed to the jade-and-gold system from edgeleadweb.netlify.app, with Anek Latin **and Anek Bangla** (the app displays scraped Bangla and had no Bangla face). Zero render-blocking scripts in `<head>`; html2pdf loads on the click that needs it; header CSS moved out of JavaScript. Top bar replaced by a grouped sidebar. |
| 10 | **Share links are client-facing** | Every share link now opens `share.html` and carries `clientReportView` — not the employee report inside the employee page with a read-only bar over it. |

## Deploy order — SQL → Render env → server → Netlify. Do not reorder.

### 1. SQL, in this order

Run each in the Supabase SQL editor. Every one is safe to run more than once.

```
sql/schema-phase12.sql     reconciliation + security fixes
sql/schema-phase13.sql     accounts, trial, quota
sql/schema-phase15.sql     assistant threads
sql/schema-phase16.sql     leads.platform + the unique key
sql/schema-phase17.sql     content_plan_notes
```

There is no phase 14 or 18 SQL — those phases were code only.

`schema-phase3.sql` was corrected in place. It is **not** re-run on a live database; the
correction only matters when rebuilding from scratch, and `schema-phase12.sql` converges any
database built from the old file.

After the run, confirm:

```sql
-- every existing lead is instagram, and the upsert key exists
select platform, count(*) from public.leads group by platform;
select indexname from pg_indexes
 where schemaname='public' and tablename='leads';

-- every existing account reads as admin or employee, with no trial window
select email, role, public.el_account_state(id) as state, trial_ends_at, paid_until
  from public.app_users order by role, email;
```

### 2. Render environment

Required — **set this or the deployed site cannot call the API at all**:

| Var | Value |
|---|---|
| `ALLOWED_ORIGINS` | The app's Netlify origin, comma-separated, no trailing slash. Add the Render origin only if you also serve the front end from there. |

Optional, all with working defaults:

| Var | Default | What it does |
|---|---|---|
| `TRIAL_ENGINES` | `report,fb_community,leadgen,meta_owned` | What a self-serve trial is granted at signup. `fb_page` and `content_plan` are deliberately absent — that is the paid surface. |
| `SIGNUP_MIN_PASSWORD` | `10` | Floor for the signup precheck. Set Supabase Auth's own minimum to match. |
| `ASSISTANT_MAX_ROUNDS` | `6` | Tool rounds before the assistant gives up on a question. |
| `ASSISTANT_HISTORY` | `20` | Turns of thread history sent to the model. |

### 3. Supabase dashboard, two settings

**Authentication → Sign In / Providers → Email:**

- **Minimum password length** → `10`. Defaults to 6, and this is the floor that cannot be bypassed.
- **Prevent use of leaked passwords** → Pro plan only. On Free it flips in the UI and fails on save.
  Our own check covers it; leave it off.

**Confirm email** must stay ON. It is what stops someone farming 7-day trials with addresses they
do not own.

### 4. Server, then pages

Deploy `server.js` to Render, wait for it to come up, then deploy `frontend/` to Netlify. In that
order: the new pages call endpoints that must already exist.

## API added or changed

| Method | Path | Notes |
|---|---|---|
| POST | `/api/public/signup/password-check` | Public, 10/min per address. `{ ok }` or `{ ok:false, reason, error }`. |
| GET | `/api/me` | **Changed.** Now returns `state`, and for clients `trial_ends_at`, `paid_until`, `plan_label`, `usage`. |
| PATCH | `/api/admin/users/:id` | **Changed.** Accepts `paidUntil`, `planLabel`, `trialDays`. Also fixes a bug where any patch silently demoted a client to employee. |
| GET | `/api/admin/users` | **Changed.** Each row carries computed `state` and `expires_at`. |
| GET | `/api/client/reports`, `/api/client/report/:id` | Client-language reports. |
| GET | `/api/client/leads`, `/api/client/demand` | Client-shaped lead list and demand feed. |
| POST | `/api/assistant/ask` (`?stream=1`) | SSE carries **status, not tokens**. Requires `X-Accel-Buffering: no`, which the handler sets. |
| GET | `/api/assistant/conversations`, `/api/assistant/conversation/:id` | Thread list and one thread. Surfaced as "Earlier" chips on the assistant page. |
| POST | `/api/fb/find-leads` | Facebook Page lead discovery. Leadgen engine, leadgen key. |
| GET | `/api/content-plan/:id` | **Changed.** Now returns `{ report, notes }`. |
| POST/PATCH/DELETE | `/api/content-plan/:id/notes`, `/api/content-plan/notes/:noteId` | Manual findings. Surfaced as the **Findings** tab on the content plan. |
| GET | `/api/public/share/:token` | **Changed shape.** Returns `clientReportView`, not the raw report. `shared.page` is always `share.html`. |

Share links created before this deploy would point at the old pages. There were none
(`select count(*) from report_shares` was 0), so nothing needs migrating.

## After deploying — check these

1. **Sign in as the admin.** The sidebar should show three groups and twelve items. If the page
   looks unstyled for a beat, `app.css` did not arrive — check the Netlify deploy.
2. **Open Admin → People.** Three buckets. Every existing account should sit under Employees or
   Admins with no billing controls.
3. **Sign up as a stranger** at `/signup.html` with a throwaway address. Confirm the email, sign
   in, and you should land on `client.html`, not the lead console, with a trial strip showing days
   left and an allowance.
4. **Run one client check-up.** It should consume quota — check
   `select * from usage_counters` — and the report should render in owner language with no raw score.
5. **Exhaust an allowance** (set `trial_caps` low in `system_settings` first). The refusal must be
   amber and in place, **not** the full-screen "your access has ended". If it takes the screen,
   `code: 'quota_exceeded'` is not reaching the browser.
6. `npm run live-checks` with two accounts, and commit the dated result file.

## Known limits — what is not finished

These are real and deliberate, not oversights:

- **No captcha on signup, by decision.** Email confirmation is the defence; captcha was considered
  and deliberately left out rather than deferred. If trial-farming ever shows up in the numbers,
  `POST /api/public/signup/password-check` is already the rate-limited choke point to add it to.
- **The mobile navigation drawer is verified statically, not visually.** Its CSS and JS were checked
  rule by rule, but the preview pane could not run style recalc to see it move. Worth opening on a
  real phone before you rely on it.
- **Apify cost constants are still estimates.** Unchanged from phase 11; the drift alarm still covers
  real spend.
- **One Render instance, still.** Rate limits, auth cache, quota caps cache and Gemini cooldowns are
  per-process. The heartbeat guard alarms if this is violated.
