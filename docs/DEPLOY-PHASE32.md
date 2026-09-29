# Deploy — phase 32

The first stage of the client-first workspace: the backend the new pages stand on. Every client gets
a **task board**, and the agency can **open the owner's portal** from the client instead of waiting
for the owner to sign up. No new page in the workspace uses these yet; stage 2 (the new layout) does.

**SQL first** (`sql/schema-phase32.sql`, in the Supabase SQL editor; idempotent), then the server.
No new dependency and no new environment variable. If the server goes out before the SQL, the task
routes answer `503` with `code: 'migration_required'` and say which file to run — nothing else is
affected.

## The task board

Two tables, RLS on both, read and written only by the server's service role:

| Table | What it holds |
|---|---|
| `client_tasks` | One card: title, notes, status (`todo`, `doing`, `waiting`, `done`), due date, labels, checklist, who it is for, whether the client sees it, where it came from, and its place in the column |
| `client_task_comments` | The conversation on a card, filed under the card's client |

The access rules are the client's rules (`clientAccess`), nothing new:

| Who | Board | Change a card | Comment |
|---|---|---|---|
| Admin, the client's owner, an editor member | reads | yes | yes |
| A viewer member | reads | no | yes |
| Anyone else | 404 | 404 | 404 |
| The business owner's portal login | never through these routes (`403 client_surface`) | only their own to-do, through `/api/client/tasks` | on cards shown to them |

- A card **for the client** (`assignee: 'client'`) is always shown to the client; a later edit cannot
  hide it. Any other card is shown only when `visibleToClient` is set.
- The portal list (`GET /api/client/tasks`) selects only shown cards and carries no ids or addresses
  of the team (rule 11). Comments read by the owner name the team, never its email addresses.
- Moving a card to Done stamps `completedAt`; moving it out clears it. A card moved between columns
  goes to the bottom of the new one unless a position is sent.
- A card made from a report recommendation (`source: { type, id, key, label }`) is made once per
  client, report and recommendation; pressing the button again returns the existing card. The report
  must be filed under the same client.
- `GET /api/my-tasks` is everything assigned to the caller on clients they can still open, soonest
  due first, with a fortnight of finished work.
- Merging two clients carries their boards and comments along (`MERGE_TABLES`).

| Route | Who |
|---|---|
| `GET /api/clients/:id/tasks` | viewer — cards, the people who can be given work, `canEdit` |
| `POST /api/clients/:id/tasks` | editor |
| `PATCH /api/tasks/:taskId`, `DELETE /api/tasks/:taskId` | editor of the card's client |
| `GET/POST /api/tasks/:taskId/comments` | viewer; the owner on shown cards |
| `GET /api/my-tasks` | staff |
| `GET /api/client/tasks`, `PATCH /api/client/tasks/:taskId` | the owner's portal login |

## The owner's portal, opened by the agency

`POST /api/clients/:id/portal-invite { email, name?, paidUntil?, planLabel? }` — the client's owner or
an admin.

1. If no login exists for the email, one is made as a **client** account on a trial (the trial length
   from Admin → Trial & plans), with the trial engines. `paidUntil` opens it on a plan instead, and only
   an admin may send it. An email that belongs to the team is refused.
2. The login is filed under **this** client (an editor member), so the owner's portal is the agency's
   record from the first sign-in. If the login already had an empty business of its own, that one is
   archived, exactly as when an owner is added by email.
3. A one-time password link is made (`auth.admin.generateLink`, type `recovery`) that lands on the new
   **`welcome.html`**, where the owner chooses a password and goes to their portal.
4. With Gmail set up, the link goes to the owner from the agency's address. Without it, and only for
   a login made just now, the response carries the link for the inviter to pass on, and says so.
   Inviting again sends a fresh link.

Two rules keep this from being a way into someone else's account:

- **A login that already existed never has its link handed back.** It goes to that person's own inbox
  or nowhere. Otherwise anyone who owns a client could type another owner's address and receive a
  password link for their account.
- **One login is one business.** A login that is already an owner on another active client, or owns a
  business record with work in it, is refused with 409 — without naming the other business. The
  portal shows the business a login resolves to; two would make that a coin toss. (The older
  add-a-member-by-email route still allows it; the new client page uses the invite.)
- Every refusal happens before anything is written, so a refused invite leaves no half-made login.

**Supabase setting to check once:** Authentication → URL Configuration → *Redirect URLs* should
include `https://edge-leadgen.netlify.app/welcome.html` (or the site's address followed by
`/welcome.html`). If it is missing, Supabase sends the owner to the Site URL instead; the login page
now forwards any such link to `welcome.html` with its hash, so it still works, just with one extra hop.

## Also in this phase

- **Monthly report filing.** `POST /api/meta/monthly` trusted any `clientId` in the body, so a report
  could be filed under a client the caller could not open. It now needs edit access to that client and
  answers 403 otherwise.
- `GET /api/clients/:id` labels each member with `accountRole`, so a page can tell the owner's portal
  login from the team.
- `wiring.test.js` names the pages that come before a session (`signup.html`, `welcome.html`) instead
  of letting a comment satisfy the EL.init check.

## Checks

`npm test` — 402 checks, 19 of them new in `usecases.test.js` (the board, its walls, the portal list,
the invite with and without mail, the two invite rules above, the recommendation added once, My tasks,
the merge, the monthly filing). After deploying: `GET /api/clients/<id>/tasks` with a staff session answers 200 with
`tasks: []` once the SQL has run, and 503 `migration_required` if it has not.
