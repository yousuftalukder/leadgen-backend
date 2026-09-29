# Deploy — phase 35

**The account assistant**, for the team, and **Edge Meta AI**, for the business owner. No SQL; server,
then pages.

## For the team: the account assistant

One chat per client, on the client's page: a box on **Overview** and the **Assistant** tab (which
replaces "Ask AI" and its choice between two assistants). It is for the account at a glance before
talking to the client: **what we did for them, what is planned, and their numbers**, short enough
to read out on a call.

It reads, for that one client only:

| Lookup | What reaches the model | What never does |
|---|---|---|
| Client card (in the prompt, no lookup) | Name, niche, Meta connected or not, report, open-task and lead counts; followers and 7-day reach (owner Meta numbers) and the last audit's grade and engagement (public data), each labelled | — |
| `get_tasks` (new) | Counts per column, up to 10 open tasks (overdue first: title, status, due, who), titles finished this month | Notes, checklists, comments |
| `get_leads_summary` (new) | Totals, with email, with phone, found this month, by platform and source, the 5 newest names | Emails, phones, bios |
| `get_work_log` (new, staff only) | Reports delivered in 30 days, work running now, failed or paused runs, the next 3 schedules | — |
| Reports, monthly report, Meta numbers | As before; a report's detail comes to staff as the gist (headline, standing, top 3 each way, summary) | — |

Kept light on purpose:

- **Three lookup rounds** per staff question (was 6), and the last round has to answer with what it
  has (`functionCallingConfig: NONE`), so a question never ends in "too much digging".
- **Eight past messages** of history for staff (was 20). Fixed on the way: history kept the
  **oldest** messages of a long thread; it now keeps the latest (owners too).
- Suggested questions under the box: what have we done this month, what is planned and waiting on the
  client, their key numbers in two lines, prep me for a call, draft an update for the owner.
- `ASSISTANT_STAFF_ROUNDS` and `ASSISTANT_STAFF_HISTORY` override the limits if ever needed.

New work's **Ask** group is now one item, **Account assistant**, which opens the client's Assistant
tab. The old `assistant.html` still works by address but is no longer linked.

## For the owner: Edge Meta AI

The owner's portal chat (`client-assistant.html`, the deep read of their own Meta data: every post,
day and ad) is now called **Edge Meta AI** in their menu and on the page. Staff can still open it for
a Meta-connected client from the Assistant tab.

## Checks

`npm test`: 421 checks, including nine new use-case tests (the card and which lookups each audience
gets, tasks overdue-first and no internal task or note for the owner, leads without contact details,
the work log staff-only, the trimmed report, three rounds with the last one forced to answer, the
latest history kept, the route). The Overview box and the Assistant tab were driven in Chromium
against a mocked stream at desktop and phone width: no page errors, no horizontal overflow.
