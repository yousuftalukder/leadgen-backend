# Phase 54 — reliability and speed (audit batch 4)

## Run

1. **SQL (optional but recommended):** run `sql/schema-phase54.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`).
   - It adds a view that counts reports per client, and an index.
   - The server works without it; until it is run, the clients list counts the old way.
2. Deploy the server, then the pages. The service worker moves to `el-shell-v7`.

## What changed

- **No more double-charged jobs after a deploy.**
  - Render starts the new server before stopping the old one. The old one, on its way out, used to mark *every* running job "interrupted", including jobs the new server had just picked up. Resuming those started a second paid copy.
  - Now a server parks only the jobs it was running itself.
- **Edge Meta AI's twice-daily read runs once, and is caught up.**
  - The 09:00 and 21:00 UTC reads are now "slots". The first server to see a passed, not-yet-run slot claims it in the database and runs it.
  - A second server during a deploy finds it taken.
  - A server that was asleep at 09:00 runs that read when it wakes, instead of skipping it.
  - Expect one extra read right after this deploy: the first server has no record of the last slot yet.
- **Faster pages.**
  - The client list is fetched once per page load. The sidebar, the picker and the page used to each fetch it.
  - *My tasks* checks access for all its clients at once, instead of three lookups per client.
  - *Clients* counts reports in the database, instead of downloading every report row. The old way stopped at 1,000 rows, so busy agencies saw wrong counts.
  - `/api/me` reads the plan's four limits at once instead of one after another.
- **AI calls time out.** A Gemini call that gets no answer in 90 seconds is dropped and retried on the next key. Before, it could hold a job, and the person's job slot, for good. `GEMINI_TIMEOUT_MS` on Render changes the limit.
- **Slow networks.**
  - In the installed apps, if a page hasn't arrived within 4 seconds, the last good copy shows and the fresh one is saved behind it. Before, only a dead connection fell back; a slow one showed a blank screen.
  - The offline copy is kept per page, not per address (`?client=…` made a new copy every time), and is capped at 80 entries.
- **Pinned libraries.**
  - The pages load exact versions from the CDN: Supabase 2.116.0, Chart.js 4.5.0, DOMPurify 3.1.6, marked 12.0.2. A new release upstream can no longer change the site overnight.
  - The scripts are not deferred: pages run their own code straight after them, so deferring would break them.

## Check after deploy

1. Open Clients: the report counts show as before.
2. Render logs at 09:00 or 21:00 UTC: one `[xp cron] running the … read` line, not two.
3. Open a page on a phone with the network throttled: the app shows within a few seconds.
