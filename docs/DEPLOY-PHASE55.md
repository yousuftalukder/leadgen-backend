# Phase 55 — server.js split into files

## Run

No SQL, no settings. Deploy as usual; Render still starts `node server.js`.

## What changed

Nothing the app does. The 22,000-line `server.js` is now a short entry file plus 21 parts in `src/`, one per area:

| File | What is in it |
|---|---|
| `01-core.js` | configuration, logging, secrets, sign-in and access rules, Apify keys |
| `02-usage-and-posts.js` | usage ledger, saving posts and reports |
| `03-analytics.js` | scores, benchmarks, recommendations |
| `04-gemini.js` | the AI key pool and calls |
| `05-jobs-quota-mail.js` | the job engine, quotas, email |
| `06-workers.js` | what each kind of run does |
| `07-system-and-admin.js` | status, signup, admin users, plans |
| `08-leads.js` | lead finding, the master list, the pipeline |
| `09-instagram-reports.js` | Instagram audits and the reports vault |
| `10-facebook-groups.js` | Facebook groups |
| `11-facebook-pages.js` | Facebook Pages |
| `12-clients.js` | the client workspace |
| `13-tasks-and-owner-sign-in.js` | task board, owner sign-in |
| `14-ai-keys-and-meta.js` | Gemini keys, Meta connection and data |
| `15-monthly-and-merge.js` | monthly owner report, comparison set, merging clients |
| `16-content-plan.js` | content plan and calendar |
| `17-schedules-and-shares.js` | scheduled runs, share links |
| `18-agency-reports.js` | the agency monthly report and photos |
| `19-reviews.js` | review tracker |
| `20-assistant.js` | the owner assistant |
| `21-runtime.js` | start-up, single-instance guard, shutdown |

The parts load in this order and share one namespace (`src/shared.js`). The split was made by a script that parsed the file and rewired every name used across parts. Nothing was retyped by hand.

## How it was checked

- **Routes:** every route and middleware registers in exactly the same order as before (220 of them).
- **Exports:** the same 197, each with the same type.
- **Timers:** the same 6 start.
- **Live responses:** the real server, booted before and after against an unreachable database, gives identical answers. Checked: health, unknown paths, the pages, the app, sign-in-protected routes, CORS and the public sign-in code endpoint.
- **Tests:** the full suite passes (508 checks). The tests that read the server's source now read `server.js` plus `src/`.
- **Syntax check:** `npm run check` and CI now check every part, not just `server.js`.
