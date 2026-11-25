# Phase 94: the Overview as an operations console

No SQL. One merge deploys the server and the pages. Nothing to switch on.

## What changed

| Area | Now |
| --- | --- |
| The Overview | A live console, dark in both themes like the menu. At the top: the LIVE light, your clock, the business's clock and whether calling is open (and for how long); the systems (phone line, mailbox sends left, the campaign sender's next run, leads waiting for a map place, how fast the server answers); six numbers with their last 14 days (calls, conversations, emails, replies, meetings, won this month), hover any day; the day's goals as rings. Below: **Up next** (the first five of Calls → Today, each with Call), **Live activity** (calls and how they went, campaign emails, replies, incoming calls, voicemail, texts, new leads), **Needs you** (replies nobody answered, a yes with nothing booked, overdue call-backs, client tasks due; open any to see the leads), **Pipeline** by stage with value and what is stuck, **Lead flow** (added → called → talked → interested → meeting → won), **Calls by hour** over 7 days on the lead's own clock (and when owners pick up most), **Revenue won** by kind of job, **By department** (7 days, 30 days, quarter), **Email campaigns**, the **Influencer network**, and the **Team** (who is on a call right now, today and the period). |
| Live | While the Overview is open and in view it asks for what changed every 30 seconds: new lines arrive at the top of Live activity, the counts and goals move, the team's status updates. On any other page, or in a hidden tab, nothing runs. |
| Speed | The first page no longer downloads the lead list. Before, opening the CRM fetched every lead (2.4 MB, 112 KB gzipped at 5,000 leads) for the Overview and the menu's counts. Now the Overview is one answer of about 2 KB gzipped, and the menu's counts are three row counts. The server builds the console once for the whole team every 20 seconds (about 15 ms for each extra person). Calls' queue is faster too: time zones are worked out once per zone and minute, not once per lead. |
| Phones | The same console, lighter to draw: no sweeping light, no blur, no glow filters. Two clocks with calling hours under them, the systems as one row you swipe, two numbers a row. |
| Less motion | People whose device asks for less motion get no animation at all. Everyone else sees the entrance once per visit. |
| Locks | Someone without Email campaigns sees the campaigns panel locked; the server does not send them the campaign figures. |

## New server routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/crm/console?days=7\|30\|90` | team | Everything the Overview draws. The shared part is kept 20 seconds; Up next, overdue call-backs and client tasks are per person. |
| `GET /api/crm/pulse` | team | The latest activity, today's counts, who is on a call, the goals. Kept 10 seconds. |
| `GET /api/crm/badges` | team | The menu's counts: cold leads, the pipeline, follow-ups due. |

`GET /api/crm/overview` and `GET /api/crm/today` still answer (nothing in the pages calls them now).

`src/25-console.js` holds it, with its pure parts tested in `tests/phase94.test.js`: `consoleSums`, `heatGrid`, `teamRows`,
`needsYou`, `feedItems`. A call counts once whether the phone placed it or it was logged by hand; a meeting once per lead a
day; the hour of a call is the lead's own clock; the feed is plain text and bold text only (the page escapes both).
