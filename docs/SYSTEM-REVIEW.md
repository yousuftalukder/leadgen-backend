# System review (November 2026, after phase 93)

What the system is for: **calling and lead management, with email campaigns.** Prospecting automation, scoring and the
social media tools come after, and must never slow those down. This review measures the system against that.

## What is in good shape

- **The server decides, the pages only show.** Phone access and hours, do-not-call, the Dialer and Email campaigns
  locks, the Tools locks and Admin are checked on the server on every request. A page can be wrong; it cannot let
  someone through.
- **Schema changes never break a deploy.** Each phase's columns are probed (`p90Ready`, `p91Ready`) and the server runs
  before and after the SQL.
- **Tests that mean something.** 32 test files, ~790 checks, on every pull request: the rules (time zones, retries,
  outcomes, access) and the routes against an in-memory database that now caps rows like the real one.
- **One lead, one history.** Calls (from the phone or by hand), texts, emails and campaign emails land on the lead's
  timeline; the counters on the lead (called, emailed, status, when to try again) are recounted from it, so the
  Leads page, Calls and the pipeline agree.
- **No build step.** Plain files on Netlify, one Node service on Render: easy to deploy, easy to roll back.

## What was fixed in this review (phase 93)

- **Silent 1,000-row limit.** The database answers at most 1,000 rows per request. The lead list, the Overview's
  figures, My numbers and campaign audiences asked for more and quietly got 1,000. At 187 leads it did not show; at
  the volumes prospecting will bring, the CRM would have hidden most leads. They now page through everything.
- **Uncompressed answers.** Nothing was gzip-compressed; the lead list now travels at a tenth of the size.
- **Everything loaded at once.** Every CRM page load fetched the whole phone inbox and downloaded Twilio before
  drawing anything else. Both now wait.
- **The Overview read every column of every lead.** It reads the ten it uses.

## Risks, in the order I would tackle them

1. **One process does everything.** The CRM API, Twilio's webhooks, the email sender, reminders, and the Apify, Gemini
   and Meta work all share one Node process on Render. A heavy job (a large Apify import, scoring thousands of leads,
   an AI report) runs on the same event loop that answers Twilio when a call comes in. Twilio waits 15 seconds; a busy
   process means a missed call.
   **Recommendation, before prospecting automation is built:** two Render services from this same repository.
   - `web`: the CRM, Calls, the Dialer, Twilio webhooks, reminders. Small, always on, never runs a job.
   - `worker`: prospecting, enrichment, scoring, email sending, the Meta and social tools. It takes work from the
     `jobs` table (which already exists) and writes results back.
   The Tools already have their own page (`/tools`), so the people side is split already; this is the server side
   of the same line. Not built yet: the plan is a `PROCESS_ROLE=web|worker|all` setting (default `all`, as today),
   so splitting becomes a Render settings change rather than a rewrite.
2. **The web service must not sleep.** Calls ring through the server. On a plan that sleeps or restarts on idle, the
   first call after a quiet spell can go to voicemail. Keep the web service on an always-on plan; the self-ping
   (`keepAwake`) is a stopgap, not a guarantee.
3. **A lot of code the CRM no longer uses.** About 32,000 lines of server code; much of it serves the Instagram and
   Facebook reports, content plans, agency reports, reviews, the website builder and the warehouse. They are
   switched off by the Tools locks, so they cost little at run time, but they load at boot, add to every deploy's
   risk, and make the codebase slower to change. **Recommendation:** list which routes the CRM, `/tools` and the
   client page still call; move the rest behind the worker or delete them.
4. **Replies are not read.** Email campaigns stop on a reply only when someone logs it. A lead who replies "not
   interested" can get the next step. **Recommendation:** read the mailbox (IMAP) every few minutes and stop the
   campaign, file the reply on the lead, and raise it in Calls.
5. **No error tracking or uptime alert.** Errors are logged, but nobody is told. **Recommendation:** an uptime check on
   `/api/health` and the phone webhook, and an error tracker (Sentry or similar) on the server and the pages.
6. **The largest file on the page is the Supabase library (218 KB)**, used only to sign in and keep the session.
   Signing in through the Supabase auth API directly would remove it. Worth doing once the rest is settled.

## Lead management: what is there, what is next

There now: add, import (CSV, with category and industry), find (search, category, industry, owner, status,
called/emailed, campaign, resting, do-not-call, wrong number), the map, bulk (pipeline, industry, category, owner,
stage, campaign, back to the call list, delete), export, the full history on each lead, duplicates refused on email
or phone, outcomes that move the lead.

Next, in order of value:
- **Merge duplicates** (two leads for one business, found by phone, email or website), keeping both histories.
- **Saved views** (a named set of filters, per person), so "my HVAC leads in Texas due a call" is one click.
- **Scoring** that sets the prospect score from the data (website, reviews, ads, size), not by hand: part of the
  prospecting automation, run in the worker.
