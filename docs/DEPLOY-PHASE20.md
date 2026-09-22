# Deploy — phase 20

The master lead list, the monthly report view, and a wiring audit that checks the seams between
SQL, server and pages.

**No SQL.** Phase 20 adds no columns, tables or indexes — `/api/leads` reads the `leads` table that
has existed since phase 3, and `monthly.html` reads the `meta_monthly` reports phase 19 introduced.
Deploy order is therefore just server, then pages.

## `npm run audit` — run this before every deploy

`tests/wiring.test.js` checks what unit tests cannot: that the layers still join up. It reads source
only — no network, no database, no Apify key — and it is the cheapest way to catch the failures that
do not throw.

| It checks | Because otherwise |
|---|---|
| Every endpoint a page calls is registered | A renamed route is a button that does nothing |
| Every registered worker has a route that starts it | A dead engine looks fine until someone clicks it |
| Every `JOB_WORKERS[...]` reference is real | `undefined` worker → 500 on click |
| Every `report_type` written has a label and a page | A timeline row reading "undefined", linking to `#` |
| Every page loads `app.css`, `header.js`, supabase, and boots `EL.init` | An unstyled page with no auth gate |
| Every nav destination exists; no page is orphaned | A 404 in the sidebar |
| No route is registered twice for one method | Express takes the first; the second is silently dead |
| `npm test` actually runs every test file | A green run that checked a fraction of the suite |

It is deliberately conservative: anything it cannot resolve statically is reported as **skipped**,
not guessed at. Its first version produced 17 false alarms (it assumed `EL.runJob` was a GET and
only read the literal prefix of a concatenated path), so the call arguments are now parsed rather
than regexed. If you change how pages call the API, re-run it and check the skip count has not
quietly grown — a rising skip count is the audit going blind, not the code getting cleaner.

## `npm test` — one runner, no `&&`

`scripts/run-tests.js` discovers every `tests/*.{test,smoke}.js`, runs them all, prints only what
failed, and aggregates. The previous `a && b && c` short-circuited: a failure in an early file
silently skipped the rest and the printed pass count was a lie about coverage. Adding a test file is
now the whole job of wiring it in.

## API delta

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/leads` | Browse with filters. `page`, `limit` (max 200), `sort` from a closed whitelist. Returns `total` and `pages`. |
| `GET` | `/api/leads/summary` | Counts by platform, enriched, reachable, plus top cities and categories. |
| `GET` | `/api/leads/export` / `.csv` | CSV of exactly what the filters select, max 20,000 rows. |

Scope is `owner_user_id` on every one. Filters are shared between the list and the CSV through
`leadFilters()`, so the export is always what is on screen.

## Post-deploy checks

1. `npm run audit` — 22 checks, 0 failed.
2. `npm test` — 10 files, 224 checks.
3. **The list matches the summary.** Open Lead List. With no filters, the count next to the table
   must equal the Total tile. If they disagree, `leadFilters` and the summary have diverged.
4. **Reachable means reachable.** Toggle "Has a contact". Every row must show at least one of email,
   phone or WhatsApp. It is an `.or()` across three columns, so a row with none of them getting
   through means the filter is not being applied.
5. **The CSV is the filtered set.** Filter to one city, export, and check the row count matches the
   on-screen count (up to the 20,000 cap).
6. **Formula injection is neutralised.** Export and open in Excel or Sheets. No cell may evaluate.
   `tests/phase20.test.js` covers this offline; do it once for real, because the consequence of
   being wrong is arbitrary formula execution in an operator's spreadsheet from a scraped bio.
7. **The monthly report opens from a timeline.** A `meta_monthly` row in a client timeline must read
   "Monthly report" and open `monthly.html`. That exact wiring is what the audit caught missing.
8. **The delta table on a phone.** At 375px the Change column must be fully visible and the page must
   not scroll sideways. Two columns are dropped at that width on purpose.

## Known limits

- **Lead-list resale packaging is still not built**, pending the legal decision on reselling scraped
  contact data (Meta ToS, GDPR/CCPA — `leads` holds email, phone and WhatsApp). The internal list
  is complete and exportable by the operator who collected it; nothing here packages or licenses it
  to a third party, and `/api/leads` does not enable that.
- **The lead list is per-account.** It is scoped to `owner_user_id`, not pooled across the team. A
  genuinely shared master list is a different design decision and a different access model.
- **Top cities and categories are tallied from the 2,000 most recent leads**, not the whole table,
  and the response says so. They are a shortcut into the filters, not an analysis.
- **The audit reads source, not behaviour.** It proves a route exists; it does not prove the handler
  is correct. That is what the phase tests and `npm run live-checks` are for.
- **Everything from phase 18 and 19's known-limits lists still applies.**
