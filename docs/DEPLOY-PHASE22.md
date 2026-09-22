# Deploy — phase 22

Every piece of work is filed under a business. This phase makes that true instead of available.

**No SQL.** Nothing new in the schema — `clients`, `client_members`, `jobs.client_id` and
`reports.client_id` have existed since phase 9. What changed is that they are now *used*: before
this phase the live database held 16 reports with 1 filed under a client, 15 jobs with 1, and 27
campaigns with 0. The picker said "None (just me)" by default and everything fell through it.

Deploy order: server, then pages. The pages tolerate the old server (they just get no `meta` on
client rows); the old pages against the new server will hit the breaking change below on every run
until the picker is used — so do not leave that state running.

## ⚠ Breaking change — job routes now require a client

Every route that creates a job — `/api/generate-ig-report`, `/api/deep-audit`, `/api/run-campaign`,
`/api/enrich-campaign`, `/api/fb/*` job routes, `/api/content-plan`, `/api/meta/sync`,
`/api/meta/monthly` — now responds

```json
{ "error": "Choose a client first. Every run is filed under a business, and this one has nowhere to go.",
  "code": "client_required" }
```

with **HTTP 400** when the body carries no `clientId`, unless the caller's role is `client`.
A client-role account is its business and files under its own record automatically.

`EL.api` adds `clientId` from the sidebar picker to every POST body, so pages need no change.
Anything calling the API directly — a script, a schedule replayed by hand, an integration — must
now send `clientId`. Schedules created before this phase carry the client they were created under;
one created with none selected will fail on its next run with this error, which is the correct
outcome: it was filing work under nothing.

## What changed

| Area | Before | Now |
|---|---|---|
| `resolveClientId` | returned `null` when nothing was sent | refuses (non-client roles); resolves a client account to its own record |
| `clientAccess` | owner or member only | **admins reach every client** (`access: 'admin'`) — "admin creates the client, assigns an employee" works on clients employees created |
| `GET /api/clients` | your own + shared | admins see all; every row carries `meta: { connected, active, pages, names }` |
| `POST /api/clients/:id/members` | owner only | admin too; adding a client-role account as `editor` **absorbs** (archives) its empty auto-created record so one business is not in two places |
| `ensureProfile` | client accounts had no `clients` row | a client account gets its business record at signup |
| `GET /api/me` | — | client accounts get `business: { id, name, ig_handle }` |
| Picker | "None (just me)" default | "Choose a client…"; hidden for client accounts |
| Work pages | picker in the sidebar footer only | a **work-for bar** at the top of every page that starts a job, jade when chosen, gold when not |
| Lead List | read-only | **Find Facebook Pages** — the phase-16 engine was wired only to the client surface; employees had no page to run it from |
| Clients page | Meta state found by opening a tab | "Meta connected · N pages" / "Meta not connected" on every row and under the title |

## Tests

Two new kinds, because two kinds of bug were getting through:

- **`tests/usecases.test.js`** drives the *real* route handlers over an in-memory PostgREST. It
  walks: admin bootstraps → creates a client → assigns an employee → employee runs work → work lands
  in the timeline → strangers are refused → admin assigns on a client an employee created → a
  self-serve client is its own business → the agency takes it on → the client sees the work → Meta
  state on the row. 24 checks. It found a real defect on its first run (`ownClientFor` leaned on a
  column default and could not find its own row), so the fake carries the schema defaults now and
  the insert is explicit.
- **Wiring audit, section 10** — every page that POSTs to a job route must be in `WORK_PAGES` and so
  carry the bar. It immediately corrected my own list (Demand Feed reads; it does not start work).

262 checks across 11 files.

## Post-deploy checks

1. Sign in as an employee with a client assigned. Open Performance Audit. The bar at the top must
   name the client. Switch the sidebar picker to "Choose a client…" — the bar turns gold, Run is
   refused with the message above, and both pickers pulse.
2. Run one audit with a client chosen. `select client_id from jobs order by created_at desc limit 1`
   must be that client. Open the client on the Clients page → Timeline → the run is there.
3. As admin, open a client an *employee* created. The Sharing tab must let you add a member. Before
   this phase that was "Client not found, or you are not its owner."
4. Sign up a fresh client account. `GET /api/me` must return `business`. `select * from clients where
   owner_user_id = <that id>` must show one row, `archived = false`.
5. Add that account as `editor` on an agency client. The response carries `absorbed: <id>`, that row
   is now `archived = true`, and the client's My Reports shows the agency's work.
6. `npm test` and `npm run audit`.

## Known limits

- **A client record with work in it is never absorbed.** If a self-serve client has already run
  something under their own record when the agency takes them on, they hold two records and their
  own runs keep going to their own. Merging records is a deliberate operation, not something that
  should happen as a side effect of adding a member; it is not built.
- **Leads are still per-owner.** `leads.owner_user_id` is the employee who collected them, linked to
  a client through `campaigns.client_id`. The master list is the agency's; there is no per-client
  lead view.
- **Facebook Page search lives on Lead List, not Lead Finder.** Lead Finder (`index.html`) is still
  Instagram-only. Putting both in one page is a UX improvement, not a capability gap.
- **The work-for bar reloads the page on change**, as the sidebar picker always has. A page mid-form
  loses its inputs. Same trade as before: every vault, estimate and source list depends on the
  client, and reloading is safer than every page re-fetching.
