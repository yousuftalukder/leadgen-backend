# Deploy — phase 23

Leads belong to clients; one business, one record; every account state refuses with the same shape.

## Deploy order

1. **SQL** — `sql/schema-phase23.sql`. Applied live as `phase23_client_leads`. Creates `client_leads`
   and backfills every Instagram lead already linked to a campaign that was filed under a client.
   Facebook leads from before this phase carried no client and cannot be recovered.
2. **Server** — `server.js`. No new environment variables.
3. **Pages** — `frontend/`.

## What changed

| Area | Now |
|---|---|
| `client_leads` | Many-to-many link, written by the Instagram campaign worker and the Facebook discovery worker. One business can be a lead for two clients; the master list is the union. |
| `GET /api/leads`, `/summary`, `/export` | Accept `client_only=1` with `client_id`. The client view is everything found **for** that client by anyone working on it, de-duplicated per business (richer row wins). Refused with 404 for a client the caller cannot read — never silently widened to their own list. |
| Lead List page | "All my leads" / "*Client*'s leads" switch; the tiles, list, empty states and CSV all follow it. |
| Clients page | A **Leads** tab (count, reachable, split by platform, first ten, open in Lead List). A **merge** control for owners/admins: dry run first, then the move. |
| `POST /api/clients/:id/merge` | `{ fromId }`, `?dry=1` to preview. Re-points every table with a `client_id` (`MERGE_TABLES`, one list), carries members and lead links over without conflicts, gives the old owner editor access, archives the source with a note naming the target. Nothing is deleted. |
| `accountDenial` | Sends `code: 'account_expired'` / `'account_suspended'`, the same codes `reserveQuota` already sent, so a page reads one field whichever door refused it. |
| `EL.api` | A 403 `account_suspended` is a first-class screen. It used to fall through and be labelled **"Backend unreachable"** — the right message under a heading that blamed us. |
| Lead Finder | A line pointing at the Lead List for Facebook Pages. |

## Post-deploy checks

1. **Backfill landed.** `select count(*) from client_leads where source = 'backfill'` should equal the
   number of `campaign_leads` rows whose campaign had a client — on the live database that was 0,
   because no campaign had ever been filed under a client before phase 22. The number matters from
   now on.
2. **The client view is client-wide.** Two employees on one client each run a search with it
   chosen. Each sees only their own finds in "All my leads" and both sets in "*Client*'s leads",
   one row per business.
3. **A stranger is refused.** As an employee not on a client, `GET /api/leads?client_only=1&client_id=…`
   must be 404, not their own leads.
4. **Merge dry run moves nothing.** Pick a source in the merge control; the note lists what would
   move; nothing in the database changes until Merge is pressed and confirmed.
5. **Suspended reads as suspended.** Set an account `is_active = false`; signing in must show
   "Account disabled", not "Backend unreachable".
6. `npm test` — 279 checks across 11 files; `npm run audit` — 36.

## Known limits

- **Facebook leads found before this phase have no client** and cannot be assigned one after the
  fact; the row never recorded who it was for.
- **The per-client view is capped at 5,000 linked leads** before de-duplication. It reads the whole
  view to de-duplicate across finders, which is right for a client and wrong for the master list —
  which is why the master list keeps its database-side paging.
- **Merge is one-way and manual.** Un-merging is not built; the archived record keeps its note.
