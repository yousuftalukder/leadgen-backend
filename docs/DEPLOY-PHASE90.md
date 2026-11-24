# Phase 90: the final CRM

Industry and the pipeline on every lead, the leads map, the client workspace, email campaigns, the Overview's
today panel and the Admin cockpit.

Order: SQL, then the server, then the pages. One merge deploys the server and the pages. The server also runs
before the SQL: everything that worked keeps working, and the new parts say "run the phase-90 SQL" until it has.

## 1. Run the SQL (Supabase → SQL editor)

Run `sql/schema-phase90.sql`. It is additive and safe to run twice.

| Table | What it adds |
| --- | --- |
| `crm_leads` | `industry`, `in_pipeline`, `pipeline_at`, `lat`, `lng` |
| `crm_tasks` | `kind` (todo, call, email) and `enrollment_id` |
| `crm_email_templates` | New table: saved emails |
| `crm_campaigns` | New table: a campaign's audience, steps and rules |
| `crm_enrollments` | New table: one lead on one campaign |
| `crm_emails` | New table: every campaign email sent, with opens |

It puts every lead past New, or already a client, in the pipeline. It does not guess industries.

Check:

```sql
select count(*) filter (where in_pipeline) in_pipeline, count(*) filter (where industry is null) no_industry from crm_leads;
```

## 2. After it runs (in the CRM, as the owner)

1. **Admin → Leads and industries.** Check the industry list. The 65 Houston leads have none yet; "Set for all" gives them one at once, for example Appliance repair.
2. **Admin → Leads and industries → The leads map.** Set "Where leads without a country are" to `Houston, TX, USA` and press **Save and place new leads**. Placing takes about a second per city. New leads are placed by themselves.
3. **Admin → Email sending.** Connect the mailbox: a Google Workspace address on edgelead.online, with an app password. Saving checks the sign-in. Set the window and the daily cap; start with 30–50 a day. Add the business address; the law asks for one in cold email.
4. **Admin → Goals.** Set the daily calls, emails, prospects and follow-ups.
5. **Admin → Client pages.** Choose the tabs every client shows. Each kind of client (its "Kind of business") or one client can have its own.

## What changed

| Area | Now |
| --- | --- |
| Overview | Client tasks due today, in 7 days or this month, with overdue first. Calls and follow-ups to do. Outreach today against the goals: calls, emails, prospects found, follow-ups, per person. Then the performance numbers as before. |
| Leads | Industry, phone, email and website on every row. Filters for category, industry and owner, with industry counts. A Map view: clusters, coloured client / in pipeline / cold / lost. Bulk: add to pipeline, set industry, category or owner, add to a campaign. Contacts are shown and copy on click; calling and emailing start from the pipeline. |
| Lead record | Outlined boxes: contact, business (industry required), deal, next step, linked. The whole history in one list (notes, calls in and out, voicemails with transcripts, texts, emails, campaign emails with opens, stage moves), filterable. A cold lead shows Email, Call, Text and WhatsApp locked until **Add to pipeline**. |
| Pipeline | Only leads in the pipeline. Category and industry counts to filter by. Industry, phone, email and website on each card. |
| Clients | Cards, and a client page: Overview, Task board, Content plan, Ad ledger, Ad brief & plan, Message templates, Billing, Reports, Team & access, Details. Which tabs show is set in Admin. |
| Email campaigns | Renamed from Sequences. Start from 7, 14 or 30 days, or blank. The builder: steps wired top to bottom, drag to reorder, click a wait to change it, + to add an email, call or task. Audience by category, industry, stage, pipeline and owner, with a live count. Stop on reply or a stage move. Open tracking. Preview, and a test to yourself. Templates. |
| Admin | One cockpit: status strip, sections with lights, collapsible cards. Settings is gone; its parts are here. |

### How campaigns send

- **Clock and limits:** the server checks every two minutes. An email goes out only if the campaign is active, the mailbox is connected and not paused, it is inside the window, and the day's cap is not spent. The cap is spread over the day.
- **Every email** carries the signature, the business address, an unsubscribe link and a one-click unsubscribe header. A lead who unsubscribes is never emailed again.
- **Call and task steps** make a task for the lead's owner, due that day: it shows on the Overview and as the lead's next step.
- **A lead leaves** when it replies (a reply logged on the lead, or moved to Replied), moves to Meeting, Proposal, Won or Lost, unsubscribes, bounces, or finishes.
- **The first email** moves a New lead to Contacted.
- **Not yet:** replies are not read from the mailbox. Log a reply on the lead (Reply in the compose box), or move it to Replied, and its campaigns stop. Reading the inbox (IMAP) is the next step.

### New server routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/crm/today?range=today\|7d\|month` | team | Goals, outreach by person, client tasks, call tasks |
| `GET /api/crm/client-schema`, `GET /api/crm/client-tabs/:id` | team | The client page's forms and tabs |
| `GET/PUT /api/admin/crm-settings` | owner | Industries, goals, client tabs, map area, time zone |
| `POST /api/admin/crm/geocode` | owner | Place leads on the map |
| `GET/PUT/DELETE /api/admin/mailbox` | owner | The campaign mailbox |
| `/api/crm/templates`, `/api/crm/campaigns…` | team | Templates, campaigns, audience, enroll, test, status |
| `GET/POST /api/public/unsub/:token`, `GET /api/public/o/:id` | public | Unsubscribe; the open pixel |

`GET /api/crm/leads/:id` adds `history`: the merged list above. `/api/crm/meta` adds industries, goals, time zone, client tabs, the mailbox's state and `p90`.

## Pages

`app/client.js`, `app/campaigns.js` and `app/admin.js` load the first time those pages open, so the CRM itself stays light.

## The voicemail email

The voicemail email's link now goes to `/#phone`.
