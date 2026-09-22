# Deploy — phase 30

The owner assistant, exactly the same for the owner as for the analyst; the numbers read every
day, with growth from the change between days; and the client surface on the phone's home screen.

**SQL first** (`sql/schema-phase30.sql`), then the server, then the pages. No new dependency.
New static files: `manifest.webmanifest`, `sw.js`, `icons/` — served by Netlify and by Render.

## What changed

| Area | Now |
|---|---|
| **The owner assistant is the analyst** | One engine, one set of tools, one set of numbers. A client account's questions are scoped to its own business, which is where a Meta connection its agency made lives; before this a client was scoped to its user id, so the Meta the agency connected was invisible and the assistant kept asking for it. Owner-side numbers are read by connection, not by who connected. The page decides "connected" from a real connection, not from the trial's engine grant. Only the register differs, by design: the owner is talked to like a knowledgeable friend, the analyst like a colleague. |
| **The numbers every day** | `meta_daily`: one row per connection, level and day. An hourly pass reads every active connection not read in the last 20 hours — followers, following and media count as of today; the ended days' reach, views, profile visits, accounts engaged, interactions, website taps and new follows, one Graph read per ended day (the first read backfills 30). Graph API only, so it costs nothing. A refused token marks the connection expired; any other failure is shown on the client's page and tried again in four hours. |
| **Growth from the change** | `growthFrom`: followers today against yesterday, a week ago and a month ago (the latest count on or before that day, so one missed day never makes a week "unknown"); reach, views, profile visits and interactions summed over the last seven ended days against the seven before, with the direction words the monthly report uses and never a percentage against nothing. Read by `/api/client/growth`, `/api/meta/growth`, the client dashboard's new card, and the assistant's `get_daily_growth`. `Sync now` reads at once. |
| **A client can connect its own Meta** | *Connect Meta* on My Reports files the connection under the client's own business and lands them back on their own page. Public accounts still need App Review; the agency's own clients can be Testers meanwhile. |
| **On the home screen** | A web app manifest, a small network-first service worker that never caches the API, icons drawn from the sidebar mark, and one card on a client's pages: *Put EdgeLead on your home screen*. Chrome hands over its install prompt; Safari on iPhone gets the three taps written out. "Not now" is remembered for two weeks; an installed app never sees it. |

## Post-deploy checks

1. **SQL applied**: `select count(*) from public.meta_daily;` returns 0 (the table exists);
   `meta_connections` has `daily_synced_at`.
2. **Within an hour of the deploy**, every active connection has `daily_synced_at` set and rows in
   `meta_daily` for the last 30 days. Or press *Sync now* on a client's dashboard.
3. **As a client whose business has a connection**: My Reports shows *Your numbers, every day*
   with today's followers and the week's reach; Ask answers "Am I growing?" with the same figures.
4. **On a phone**: open the client dashboard signed in; the card offers *Add to home screen*
   (Android: a real prompt; iPhone: the written steps). The installed app opens full screen on
   My Reports.
5. `npm test` — 373 checks across 12 files, 116 walked flows; `npm run audit` — 38.

## Known limits

- **A day's activity is written the day after.** Instagram's totals for a day are only complete
  once it ends, so "yesterday" is the most recent activity row; followers are today's count.
- **Instagram's per-day metrics** are read with `metric_type=total_value` per day. If Meta retires
  one, it lands in the connection's warning and the rest keep coming.
- **The install prompt is Chrome's to give.** Some browsers never fire it; those get the written
  steps. On iPhone the installed app keeps its own sign-in.
- **Two connections for one business** (one from onboarding, one from the real authorisation): the
  active one with an Instagram account and a token is the one shown and synced.
