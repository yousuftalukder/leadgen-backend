# Phase 93: a faster server, every row, the parts the owner hands out, the small Dialer

No SQL. One merge deploys the server and the pages. **Render installs one new package (`compression`) on deploy.**

## Do this right after it deploys (as the owner)

**Admin → Team: unlock the Dialer and Email campaigns for the people who should have them.** From this phase both
are locked for every teammate until you switch them on, person by person. You always have both. Calls (Home,
My numbers, Settings) is not affected: it follows Admin → Phone as before.

## What changed

| Area | Now |
| --- | --- |
| Speed: the server | Every API answer is gzip-compressed (a 2,000-lead list goes from ~150 KB to ~11 KB). Event streams (the assistant) are left alone. |
| Speed: the pages | The CRM draws at once from the settings it saw last (same person, under 12 hours old) and refreshes them alongside. The calling software (Twilio, a few hundred KB) loads after the page is drawn. The Dialer's calls and texts load only when the Dialer opens; elsewhere the badge is one small count every 30 seconds. The browser opens its connection to the server while the page loads (preconnect). |
| Every row | The database answers at most 1,000 rows per request. The lead list, the Overview's figures, Calls, My numbers, Today, email campaign audiences and statistics, the phone's month and the map read past that now (pages fetched in parallel). Before, they would have stopped at 1,000 without saying so. |
| The Dialer | Locked per person (Admin → Team). The server refuses its calls and texts list, conversations, texts, contacts, recordings, and calls dialled on its keypad; a call from Calls (with its lead) still goes through. |
| Email campaigns | Locked per person (Admin → Team). The server refuses every campaign and template route; the menu, the lead record and the Leads bulk bar show the lock. |
| The installed Dialer | Opens as a small phone (about 400 × 780 on a computer): **Keypad** first, then **Recents** (the calls and texts) and **Sound**, with the tabs at the bottom. New icon: the gold E with a green dialer. In the CRM the Dialer keeps its wide layout; "Open in its own window" opens the small one. |
| The left menu | Work: Overview, Leads, Pipeline, Calls, Email campaigns. Business: Clients, Influencers. Owner: Admin, Tools. **Phone: Dialer**, on its own at the end. Locked parts show a lock and say how to get them. |
| Leads | **Export**: the leads the filters show, as a CSV file (contact, stage, owner, calls, emails, campaign, tags…). Bulk **Move to stage**. The owner can **Delete** a lead (from its record) or many (bulk); leads that became clients are never deleted. |
| The lead record | **Open in dialer** (it opens the lead in Calls, to call it and log how it went). **Add to campaign** shows a lock when campaigns are locked. |
| Calls → My numbers | Tiles in three groups (Activity, Conversations, Results), each with an icon, a plain label, the number and one line saying what it means. |

## New server routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/admin/features`, `PUT /api/admin/features/:id` | owner | Who has the Dialer and Email campaigns |
| `GET /api/phone/unread` | team | The badge: missed calls, voicemail and texts nobody opened |
| `POST /api/crm/leads/bulk-delete` | owner | Delete up to 500 leads (clients kept) |

`GET /api/crm/meta` adds `features` (what this person has). `GET /api/crm/leads` returns every lead (it used to
take `limit`, up to 2,000, and was cut at 1,000 by the database).

`S.selectAll(table, columns, filters, { max, order })` in `src/25-crm.js` is the helper for any query that may pass
1,000 rows. Use it instead of `.limit(n)` with n over 1,000.
