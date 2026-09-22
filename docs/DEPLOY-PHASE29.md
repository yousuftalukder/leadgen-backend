# Deploy — phase 29

One master lead list for the whole agency, filed by industry and location; mail from the agency's
own Gmail; and the go-live list settled by the owner's answers.

**SQL first** (`sql/schema-phase29.sql`), then the server, then the pages. Server: one new
dependency (`nodemailer`) — Render installs it on deploy. Pages: `leads.html`, `admin.html`.

## What changed

| Area | Now |
|---|---|
| **One master list** | Every lead anyone here collects — an employee's campaign, a colleague's Facebook search, a trial client's own draw — lands in one place. Admins and employees read it through the `leads_master` view: one row per business across every owner (enriched over not, then newest), with `copies` saying how many people found it and `found_by` saying who. **Mine** narrows to the caller's own rows. A client account only ever sees its own, however it asks. Until now the list was per account: two employees each had their own and nobody had the whole. |
| **Filed by industry and location** | Two new columns on `leads`. The search that found a lead fills them — the campaign's keyword or the method's own, the place searched (never a pasted explore URL); a Facebook Page is filed under the keyword that found it. The profile's own category and city fill in when the search said nothing, and every existing row is backfilled the same way. The Lead List filters on both (older rows that only know their own category and city are still found), suggests the values it has seen, and the CSV carries `industry`, `location` and `found_by`. |
| **Mail from your Gmail** | Admin → Trial & plans → **Email**: a Gmail address, an app password (Google Account → Security → 2-Step Verification → App passwords), an optional sender name and notification address, and *Send a test email*. The password is sealed with the same key as the Apify tokens and never sent back to a browser. Three messages and nothing else: a business starts a trial (to you), a client asks to continue (to you), you activate a plan (to the client). A Gmail refusal is shown on the admin page and never fails the request it rode on. |
| **`docs/GO-LIVE.md`** | Rewritten from the owner's answers: no resale packaging was ever wanted (one list was), no developer is joining, the repository goes public, mail is done. |

## Post-deploy checks

1. **SQL applied**: in the SQL editor, `select count(*) from public.leads_master;` returns a number
   (the view exists) and `select count(*) from public.leads where industry is null and category is not null;`
   returns 0 (the backfill ran).
2. **Lead List** as an admin or employee: the scope reads *Everyone's leads*, the table has *Filed
   under* and *Found by* columns, the chips read *Industries* / *Locations*. *Mine* narrows it. As a
   client account the two switches are absent and only its own rows show.
3. **Email**: Admin → Trial & plans → Email — save a Gmail address and an app password, press *Send a
   test email*, and it arrives at the notification address (check spam the first time). Then sign a
   throwaway client up: the "New trial" mail arrives.
4. `npm test` — 346 checks across 11 files, 106 walked flows; `npm run audit` — 38.

## Known limits

- **Gmail's ceiling** is about 500 messages a day from one account, and Google may pause an account
  that sends bulk. Three notifications a signup will never reach that; a marketing blast would, and
  is not what this is for.
- **Mail links** use `FRONTEND_URL` when it is set, else the first `ALLOWED_ORIGINS` entry, else the
  text names the page without a link. Set `FRONTEND_URL` on Render if it is not already.
- **The view is a full sort** over `leads` on each read (distinct on business). Fine to six figures;
  if the list ever passes that, a materialised copy refreshed on write is the next step, not a
  rewrite.
- **Backfill picks one campaign** when a lead was found by several. The row's filing is that
  campaign's keyword and location; the others are still reachable through the client views.
