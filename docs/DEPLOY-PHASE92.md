# Phase 92: Calls and the Dialer, and what a call does to a lead

The phone is split in two. **Calls** is the sales calling, worked from the lead list. **Dialer** is the phone system
on its own. A call's outcome now changes the lead everywhere: its sales stage, its email campaigns, and when it
comes back to the call list.

No SQL. It needs `sql/schema-phase91.sql` (already run). Settings live in `system_settings`. One merge deploys the
server and the pages.

## After it deploys (as the owner)

1. **Admin → Calls** (was Admin → Dialer). Check the new cards: *When a closed lead comes back* (90 days after Not
   interested, 30 days after running out of tries) and *Reminders* (the office's standard times, 1 hour, 15 and 5
   minutes before a callback).
2. Tell the team: **Calls → Settings** sets their own reminder times and desktop alerts; **Dialer → Sound and app**
   is where the app is installed.
3. Anyone who installed the Phone app: it is now **EdgeLead Dialer**. The installed app keeps working; its name
   updates the next time it opens.

## The left menu

| Before | Now |
| --- | --- |
| Phone (call list, inbox, settings) | **Calls**: Home, My numbers, Settings |
| | **Dialer**: the phone on its own (keypad, calls, texts, voicemail, sound, install) |
| `E` square | The EdgeLead mark |
| Always wide | Folds to icons with the button by the logo; remembered per browser |

On a phone the bottom bar is Home, Leads, Pipeline, **Calls**, More (Email campaigns, Dialer, Clients, Influencers,
Admin). Old `#phone` links (the voicemail email) open the Dialer.

## What a call does to a lead

| Outcome | Calls | Leads page and pipeline | Email campaigns |
| --- | --- | --- | --- |
| No answer, voicemail, busy, owner not in | Back after the retry hours. After 6 in a row with no conversation it rests, and is back in 30 days with a fresh count. | Unchanged | Unchanged |
| Talked, follow up | Back in 3 days | Unchanged | Unchanged |
| Call back at a set time | At that time. A call task, with reminders. | Shows the task | Unchanged |
| Interested | In play | Into the pipeline at Contacted (also from Lost) | **Stopped**: sales has it |
| Booked a meeting | In play | Into the pipeline at Meeting | **Stopped** |
| Not interested, Not a fit | Closed, back in 90 days | **Lost**, with the reason ("Not interested (on a call)") | **Stopped** |
| Wrong number | Closed until the number is fixed | Marked *Wrong number*; a new number puts it back in the call list | Unchanged |
| Do not call | Never again | Marked *Do not call*; Call and Text are off | **Stopped**, and unsubscribed for good |
| They asked for an email | (with any outcome) | An email task, due now | |

The panel shows what the chosen outcome will do before it is saved, and the toast says what it did.

**Do not call** is enforced by the server: the voice webhook refuses a call to that number and texts to it are
refused. Only the owner can **Allow calls again**, from the lead (they stay unsubscribed from email).

**Back to the call list**: on the lead record and in the Leads bulk bar, for closed or lost leads. Lost leads come
back as New (or Contacted if they are in the pipeline). Do-not-call and wrong-number leads are left out.

## Calls and email campaigns together

- A campaign's **call step** that is due puts the lead at the top of Calls → Today, with the step's title.
- Each lead in Calls shows its email campaign and the date of the next email; so do Leads (in the Called · emailed
  column) and the lead record.
- Leads has new filters: in an email campaign now, not in one, resting (back later), do not call, wrong number.

## Calls → My numbers

Today, 7, 30 or 90 days. Calls and leads called, calls per hour (over the hours with a call), answered, reached the
owner (and front desk), time on calls, call-backs set and how many due were made, interested, meetings, emails asked
for, not interested, wrong numbers and do-not-call, and calls logged without dialing. The hour owners pick up most,
on their own clock (hours with 8 or more calls). Calls by day, split by who picked up. How the calls went. A teammate
sees their own; the owner can pick anyone or the whole team.

## Calls → Settings (each caller's own)

- **Reminders** before a call-back or a timed to-do: 1 day, 2 hours, 1 hour, 30, 15, 10, 5 minutes, or when it starts.
  The office's times until the caller picks their own. Snooze time. A tone, with **Hear it**.
- **Desktop alerts** when the CRM is in the background, with a test alert.
- Their calling hours, and the sound settings for this computer.

A reminder pops up on every page of the CRM and the Dialer: **Call now**, **Open**, **Snooze**, **Done**.

## New server routes

| Route | Who | What |
| --- | --- | --- |
| `POST /api/crm/dialer/reopen` | team | Back to the call list, for up to 500 leads |
| `GET /api/crm/calls/stats?range=&user=` | team (owner: anyone, or `all`) | My numbers |
| `GET/PUT /api/crm/caller-prefs` | team | The caller's own reminder times, snooze, tone, desktop alerts |
| `GET /api/crm/reminders` | team | The caller's open tasks from 2 hours ago to a day ahead, with the lead |

`POST /api/crm/dialer/outcome` now returns `stage`, `campaignsStopped` and `outOfTries`. `GET /api/crm/leads` and
`GET /api/crm/dialer` carry each lead's active `campaign`. `PUT /api/admin/dialer` takes `revisit`, `reminders`, `snooze`.

## Fixed

- The Dialer's (before: the Phone's Inbox) list of calls and texts emptied itself when clicked, instead of opening the
  conversation. The page marked itself with the same attribute the list's filter tabs use.
- Toasts no longer stack on top of each other.
