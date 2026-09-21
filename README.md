# EdgeLead

*Meta Business Suite for doing, EdgeLead for knowing what to do and proving it worked.*

Social media intelligence and reporting for SMM freelancers: Instagram audits and competitor intel, Facebook community discovery / audit / demand feed / post advisor, FB Page reports, content plans, client workspaces, scheduled runs and read-only client share links. Pairs with Canva and Meta's native scheduler for execution.

Since phase 13 it is **two products on one backend**: the employee workbench above, and a self-serve client surface with a free trial, per-account quota and reports written in owner language rather than agency language.

**This folder is the only copy of the product.** Phase 18 (September 2026). If a file is not here, it is not the product.

## Layout

```
server.js          Express backend, single file, Phase 17. Deployed to Render.
package.json       start: node server.js · test: offline tests · live-checks: post-deploy script
frontend/          Static site, deployed to Netlify. header.js is the shared runtime every page
                   loads; app.css carries every shared rule including the header shell.
                   Employee pages and the client surface (signup.html, client.html,
                   client-assistant.html, client-leads.html, client-community.html, share.html)
                   share it;
                   header.js picks the
                   nav from the caller's role.
sql/               Every migration, in order. History is kept: schema.sql, fb-schema.sql, fb-page-schema.sql, schema-phase1..17.sql
docs/              DEPLOY-PHASE18.md covers phases 12-18 in one deploy; DEPLOY-PHASE*.md (per phase), PLAN-PHASE8.md §D (IG expansion spec), LIVE-CHECKS-*.md (dated certification)
scripts/           live-checks.js — two-account concurrency + access checks against the real deployment
tests/             phase11 / phase13 / phase14 / phase15 / phase16 / phase17.test.js (pure logic, all deps stubbed) · header.smoke.js (page contract in a stub DOM)
.claude/           launch.json — serves frontend/ on :5500 for local checks
netlify.toml       base = frontend
```

## Stack and scope (unchanged)

Node/Express single file · Supabase (Postgres + auth, RLS on every table, server holds the service role) · Apify (scraping) · Gemini (narratives, pooled keys) · vanilla multi-page HTML/JS · Render + Netlify.

Deliberately **not** in scope: Meta publishing, inbox, ads, photo editing, Google Maps, ORM, microservices, a frontend framework, likers/followers scrapers.

## Rules that keep it working

1. **Server is the API contract; pages conform.** Key-name mismatches are the most frequent bug class.
2. **Every schema change is a numbered SQL file. Deploy order is always SQL → server → pages.**
3. **Scraped and owner-Insights metrics are never blended.** Every metric carries a `source` tag.
4. **All work runs through the job engine** (`createJob → runJob`, atomic claim, checkpoint/resume, budget reservation). Never inside an HTTP handler.
5. **Median first; thin samples are damped; vendors are filtered.**
6. **One Render instance.** Rate limits, auth cache, Gemini cooldowns and resume state are per-process. The heartbeat guard alarms if this is violated.
7. **Estimates say "estimate".** Apify cost constants are unvalidated; the drift alarm (`cost_estimate_drift`) covers real spend.
8. **Engine access decides whether, quota decides how much.** Two separate gates. A grant without a ceiling opens the shared pool; a ceiling without a grant is unreachable.
9. **Account state is derived from time, never stored.** `el_account_state()` and `accountState()` must agree. Nothing schedules a trial's expiry — it lapses on its own.
10. **402 is two different things.** `code: 'account_expired'` is terminal and takes the screen; `code: 'quota_exceeded'` is one refused action and is shown in place.
11. **The client surface has its own endpoints.** `/api/client/*` never selects credits, set ids or source report ids — that is enforced by not selecting them, not by filtering them out.
12. **The assistant reads through bounded tools, never free SQL.** Scope is resolved server-side and passed in; no argument the model invents can widen it. A bad model turn costs a wrong sentence, not a wrong read.
13. **Facebook leads come from Pages, never from groups.** The group pipeline hashes author identity on purpose (`author_hash` is one-way; `author_label` holds only 'admin'/'member'). A Page publishes its own contact button; a group member did not. Do not "fix" `author_hash`.
14. **One lead list, keyed `(owner_user_id, platform, username)`.** Handles are lower-cased by the writer, because the key is plain columns — PostgREST's `on_conflict` cannot name an expression index.
15. **A plan may only recommend spending money on something already winning organically.** `cpBoostCall()` enforces it; the prompt only asks. A `why=gap` cell is unproven for that account by definition.
16. **Manual findings are a third source, never blended.** Human observations live in `content_plan_notes` and are rendered as somebody's note — they never feed a computed index, the same way scraped and owner metrics never mix.
17. **No render-blocking JavaScript in `<head>`, and no CSS injected from JavaScript.** Styles belong in `app.css` so they arrive with the stylesheet; a `<script src>` above the fold delays the first paint for everyone. Heavy one-off libraries load on the click that needs them.

## Working on it

```
npm install
npm run check          # syntax gates
npm test               # 132 offline tests + header smoke
```
Patch with exact-match guards (assert one hit, abort on miss); run `node --check` after every write; extract inline `<script>` blocks and check each. Then commit.

## Deploy

See `docs/DEPLOY-PHASE11.md`. After every deploy run `npm run live-checks` with two accounts and commit the dated result file.

## Where things are in `server.js`

| Area | Anchor |
|---|---|
| Auth, engine grants, key resolution | `async function auth(`, `requireEngine(`, `getWorkingClient(` |
| Job engine | `// JOB ENGINE`, `claimJob(`, `runJob(`, `registerWorker(` |
| IG analytics | `igNormalisePost(`, `igDistribution(`, `computeAudit(`, `extractBioContacts(` |
| Leadgen pipeline | `leadgenUnits(`, `igPlaceUrls(`, `registerWorker('leadgen_campaign'` |
| FB community / page | `fbEstimateCredits(`, `fbPageEstimateCredits(`, `/api/fb/` |
| Clients | `clientAccess(`, `resolveClientId(`, `applyReportScope(`, `canReadReport(` |
| Content plan | `CP_PLATFORMS`, `/api/content-plan`, `cpBoostCall(`, `content_plan_notes` |
| Schedules, share links, instance guard | `// PHASE 11 :: SCHEDULED RUNS`, `// PHASE 11 :: READ-ONLY REPORT SHARE LINKS`, `// PHASE 11 :: SINGLE-INSTANCE GUARD` |
| Accounts, trial, quota | `accountState(`, `accountDenial(`, `reserveQuota(`, `takeLeadQuota(`, `el_account_state` |
| Client surface | `clientReportView(`, `clientStanding(`, `/api/client/`, `CLIENT_NAV` in header.js |
| Signup | `isLeakedPassword(`, `/api/public/signup/password-check`, `ensureProfile(` |
| Owner assistant | `ASSISTANT_TOOLS`, `assistantAnswer(`, `geminiToolTurn(`, `/api/assistant/` |
| Facebook leads | `fbPageToLead(`, `fbPageSearchRefs(`, `registerWorker('fb_lead_discovery'`, `/api/fb/find-leads` |
| Boot, schema probe, preflight | `async function start(`, `schemaProbe(`, `preflight(` |
