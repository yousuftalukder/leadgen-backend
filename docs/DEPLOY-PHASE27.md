# Deploy — phase 27

Where to send the money, and the business in five numbers.

**No SQL.** `contact_email` and `payment_options` are rows in `system_settings`, which is a key/value
table; nothing in the schema changes.

Deploy order: server, then pages.

## Why

Money is collected outside the product, by decision. That only works if the client is told *where
to send it*. Until now the contact address was a build-time constant in `header.js` — blank — and
the legal pages had their own blank copy; nowhere told a client how to pay. Now an admin sets one
email and up to six ways to pay, once, and every place a client is asked to continue reads them.

## What changed

| Area | Now |
|---|---|
| Admin → Trial & plans | **Contact & ways to pay**: an email, and rows of *label · details · optional link* (bKash, bank transfer, a card link…). Saved with the limits. |
| `GET /api/public/contact` | Public and unauthenticated on purpose: the expired screen has no session to speak of, and the privacy page has no account. Rate-limited per IP. |
| `PATCH /api/admin/settings` | Accepts `contactEmail` (must look like an address, or blank to clear) and `paymentOptions` (cleaned; a link must be `http(s)`; an empty row is dropped; six at most). |
| The slots | One renderer in `header.js` (`contactSlotHtml`) feeds four places: the **trial banner** once a request is sent; the **expired screen** beneath its actions; the **request confirmation**; and the **privacy and terms pages'** contact line, which now read the same endpoint instead of a hardcoded blank. `SUPPORT_EMAIL` remains a build-time fallback only. |
| Admin → People | A **funnel strip** above the buckets: on trial · ending this week · waiting to continue · paying · lapsed. Computed from the same rows the buckets draw, so it can never disagree with the list under it. "Waiting" jumps to the first client who asked. |

## Also in this phase — the monthly report, walked

`tests/usecases.test.js` now runs the monthly owner report end to end against a **scripted Graph
API**: a fetch stub that answers Page and Instagram insights for two months (chosen by the `since`
the server asks for), the account, follower demographics, the month's media and each post's
insights, with fixed numbers so the arithmetic can be checked exactly. The walk proves: the run is
queued under the client and finishes; `snapshot_date` is the 1st of the month reported; reach reads
47.2% up; a metric that was zero last month reads "new" and never a percentage; a 0.6% move reads
"flat"; only the month's posts are counted; `sources.all` is owner insights and nothing scraped;
and the analyst's `get_monthly_report` returns the same 47.2%. No code changed for this; a row of
the model moved from UNIT to E2E.

## Post-deploy checks

1. Admin → Trial & plans: set an email and one way to pay; Save. Open `privacy.html` signed out —
   the contact line shows the address.
2. As a trial client, press the banner's action: the ways to pay appear under the banner.
3. Expire a test client; the expired screen shows "Ask to continue", the email link, and the ways to
   pay.
4. Admin → People: the strip's "waiting" count matches the chips below; clicking it opens the first
   one.
5. `npm test` and `npm run audit`.

## Known limits

- **Nothing verifies a payment.** The client pays outside the product and the admin activates by
  hand; the product only says where and confirms the request was received.
- **The legal pages read the address live.** If the backend is asleep when a reviewer opens the
  page, the fallback line ("contact your account administrator") shows until it wakes.
