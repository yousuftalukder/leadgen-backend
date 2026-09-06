# EdgeLead

*Meta Business Suite for doing, EdgeLead for knowing what to do and proving it worked.*

Social media intelligence and reporting for SMM freelancers: Instagram audits and competitor intel, Facebook community discovery / audit / demand feed / post advisor, FB Page reports, content plans, client workspaces, scheduled runs and read-only client share links. Pairs with Canva and Meta's native scheduler for execution.

**This folder is the only copy of the product.** Phase 11 (September 2026). If a file is not here, it is not the product.

## Layout

```
server.js          Express backend, single file, Phase 11. Deployed to Render.
package.json       start: node server.js · test: offline tests · live-checks: post-deploy script
frontend/          Static site, deployed to Netlify. header.js is the shared runtime every page loads.
sql/               Every migration, in order. History is kept: schema.sql, fb-schema.sql, fb-page-schema.sql, schema-phase1..11.sql
docs/              DEPLOY-PHASE*.md (deploy order + API contract per phase), PLAN-PHASE8.md §D (IG expansion spec), LIVE-CHECKS-*.md (dated certification)
scripts/           live-checks.js — two-account concurrency + access checks against the real deployment
tests/             phase11.test.js (pure logic, all deps stubbed) · header.smoke.js (page contract in a stub DOM)
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

## Working on it

```
npm install
npm run check          # syntax gates
npm test               # 26 offline tests + header smoke
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
| Content plan | `CP_PLATFORMS`, `/api/content-plan` |
| Schedules, share links, instance guard | `// PHASE 11 :: SCHEDULED RUNS`, `// PHASE 11 :: READ-ONLY REPORT SHARE LINKS`, `// PHASE 11 :: SINGLE-INSTANCE GUARD` |
| Boot, schema probe, preflight | `async function start(`, `schemaProbe(`, `preflight(` |
