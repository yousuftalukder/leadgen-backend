# Phase 91: the dialer, phone access and hours, called and emailed on every lead

The Phone becomes a calling workstation: a call list on the left, the lead with everything we know in the middle,
the call and how it went on the right. The owner decides who has the phone and when it works. Leads shows who was
called and emailed.

Order: SQL, then the server, then the pages. One merge deploys the server and the pages. The server also runs
before the SQL: calling keeps working, and the new parts say "run the phase-91 SQL" until it has.

## 1. Run the SQL (Supabase → SQL editor)

Run `sql/schema-phase91.sql`. It is additive and safe to run twice. It adds to `crm_leads`:

| Column | What it holds |
| --- | --- |
| `call_status` | Where the lead is in the dialer: not_called, tried, spoke, callback, in_play, closed |
| `calls_count`, `last_call_at`, `last_call_outcome` | Calls made to it, the last one, how it went |
| `callback_at` | When to try it again |
| `emails_count`, `last_email_at` | Emails sent to it, by hand or by a campaign |
| `insights` | "What we noticed": short lines about the business |

It fills them from each lead's history: calls out and emails sent are counted, won, lost and client leads are
closed, leads being worked in the pipeline are in play, and leads called before are Tried, due again a day after
their last call.

Check:

```sql
select call_status, count(*), sum(calls_count) calls, sum(emails_count) emails from crm_leads group by 1 order by 1;
```

## 2. After it deploys (as the owner)

1. **Admin → Phone → Who can use the phone.** Until you save this, everyone on the team can call at any time,
   as before. Pick the hours (for example Mon–Fri, 9 AM to 5 PM, Eastern), switch the phone on for each teammate,
   and give anyone their own hours if they need them. You, the owner, are never locked out.
2. **Admin → Dialer.** Add the call lists the team works from (by category, trade, cold or pipeline, emailed or
   not, lowest score, and who sees each list). Check the retry times and the business-hours rule.
3. **Phone → Settings** on each computer: pick the microphone, run the call-quality test, and install the app.

## What changed

| Area | Now |
| --- | --- |
| Phone | Three tabs: **Dialer**, **Inbox** (the calls and texts as before) and **Settings**. Your clock and the lead's clock across the top. **Install app** on every screen. |
| Dialer | Search, call list and trade filters; tabs Today, Not called, Tried, Spoke, Call back, In play, Closed, All, with counts. Today's calls and conversations for you. The list resizes by dragging its edge and folds away; so does the call panel; double-click an edge to fold it; the sizes are remembered. Keys: J / K or the arrows move, C calls. |
| The lead in the dialer | Who to ask for, the number large with **Copy**, email, website, Google Maps, address. Status and last outcome, their local time and whether they are open, warmth (from email), prospect score, trade, category, every call and email, when to try again, "What we noticed", and the history. |
| A call | Notes while you talk, mute, keypad, a live sound-quality meter. After it: who picked up (the owner, front desk, someone else, no one), then how it went. **Save and next lead** goes straight on. |
| Outcomes | No answer, voicemail, busy and Owner not in come back after the retry time; after the set number of tries the lead closes. Talked, follow up comes back later. Call back at a set time makes a call task. Interested and Booked a meeting put the lead in the pipeline (Contacted, or Meeting). Not interested, Not a fit, a wrong number and Do not call close it; Do not call also tags it. "They asked for an email" makes an email task. The outcome is filed on the call the phone logged, never twice. |
| Phone access | Locked, or outside the hours: the teammate sees the Phone and every lead, but every call, text and keypad control is off, with "Calling opens Mon 9:00 AM EST". It unlocks by itself when the hours open. The server checks it on every call, text and outcome, and incoming calls ring only people who may answer now. |
| Voice quality | Opus wideband first, G.711 as the fallback; the nearest Twilio data centre (or the owner's pick, with the nearest as the fallback); echo, noise and level control in the browser (each can be switched off in Settings); microphone and speaker choice; a level meter; a 20-second call-quality test (sound score, delay, jitter, which data centre); and the live quality meter during a call. |
| The installed app | Installs on phones (Android: Chrome menu; iPhone: Safari → Share → Add to Home Screen) and computers. It asks for the workspace password each time it opens, and again after 15 minutes in the background, never during a call. |
| Leads | A **Called · emailed** column: how many times, the last outcome and when. A filter: never called, called, emailed, never emailed, both, neither, due a call now, and each dialer status, with counts. A **Copy** button beside every phone number. |
| Lead record | The phone number (and WhatsApp and email) under the name, each with **Copy**. Called and emailed counts, and when to try again. **Call** works on cold leads too, and **Open in the dialer**. "What we noticed", one line each. |

## New server routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/crm/dialer?tab=&list=&industry=&q=` | team | The queue: counts per tab, the leads in calling order with their time zone and whether they are open, your day so far, the outcomes |
| `POST /api/crm/dialer/outcome` | team, with the phone now | Who picked up and how it went |
| `GET/PUT /api/admin/phone/settings` | owner | Who can use the phone and when; the Twilio data centre |
| `GET/PUT /api/admin/dialer` | owner | Call lists, retry times, the business-hours rule |

`GET /api/phone/config` adds `access` (may I call now, and when it opens or closes) and `voice`. The voice webhook
takes a `LeadId`, refuses a call from someone who may not call now, and answers the call-quality test with a quiet line.
Settings live in `system_settings`: `phone_access`, `phone_voice`, `dialer_rules`.

## How a lead's time zone is found

What is set on the lead; else the state in its address (the area code settles states that span two zones, such as
Kentucky, Tennessee, Texas and Indiana); else the area code; else its country; else the business time zone.
