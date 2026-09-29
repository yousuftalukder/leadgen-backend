# Deploy — phase 33

The client-first workspace, stage 2: the menu, Home, My tasks, Clients and a page for each client.
Front end only, apart from one assistant fix; it stands on phase 32's routes, so **phase 32's SQL
first** (`sql/schema-phase32.sql`). Until it has run, the task board and My tasks say so in place
and everything else works.

## What changed for the team

| Before | Now |
|---|---|
| A menu of 15 tools grouped by platform | Five places — **Home, My tasks, Clients, Leads, Schedules** — plus Admin. The tools live under **New work** |
| The client was a dropdown in the sidebar footer | The client is a page: `workspace.html?client=<id>` |
| "Clients" was a form with six tabs beside a list | `clients.html` is the list, with **Add client** and the Meta "Pages you manage" inbox |
| Tools asked "which client?" after you opened them | **New work** asks first, then opens the tool with `?client=`, so it is filed before it starts |
| "Analyst" and "Owner Assistant" | **Ask AI · reports and research** and **Ask AI · their Meta numbers**, both reachable from the client |
| The owner assistant was for client accounts only | Staff open it for any client they can read (`client-assistant.html?client=<id>`) |
| No front page | `home.html`: what needs attention, your tasks, what is running, your clients, your latest reports. The sign-in page sends staff here |

## The client's page

Tabs, each a link (`?client=<id>&tab=<name>`), so any of them can be bookmarked or sent:

- **Overview** — their own numbers when Meta is connected (followers, reach, profile visits,
  interactions, each labelled *Owner data · Meta*), otherwise the latest audit (labelled *Public
  data*); a setup checklist until details, Meta, a first report and the owner's portal are done;
  running work and open tasks.
- **Tasks** — the board: To do, In progress, Waiting on client, Done. Drag to move; open a card for
  status, assignee, due date, label, notes, checklist, whether the client sees it, and the
  conversation.
- **Reports** — every report filed under the client, filterable by type, opening on the page in the
  same viewer as before (the engine page embedded with `?embed=1`).
- **Leads** — what was found for the client, and the local-demand tools.
- **Meta** — connections, *Read numbers now*, the 28-day owner report, the day-by-day table, and
  monthly reports: listed, and built for any finished month from here.
- **Ask AI** — the two assistants, for this client.
- **Schedules**, **Access & sharing** (the team on the client, the owner's portal invite from phase
  32, share links), **Settings** (details, competitors with *Suggest similar businesses*, archive,
  merge, delete).

Everything the old client form did is here; `clients.html?client=<id>` (old links, and the Meta
sign-in's return address) forwards to the client's page, Meta result included.

## Shared pieces

- `header.js` — the new menu, **New work** (grouped by goal: check performance, compare with
  competitors, plan content, find customers, ask), client search, recent clients, counts on My tasks
  and Clients, and three primitives every page can use: `EL.drawer()`, `EL.toast()`, `EL.icon()`.
  `?client=<id>` in any address makes that client the chosen one before the page reads it.
- `ui.js` (new) — the task board and task drawer, task rows, the add-client flow, and the report-type
  names (`TYPE_LABEL`, `TYPE_PAGE`), which the wiring audit now checks there.
- `app.css` — the shell additions and the `ws-*` workspace rules; `input:not([type])` is styled like
  every other text input, and `[hidden]` always hides.

## Fixes

- **Ask AI answered an admin about the wrong data.** Its scope counted only owned and member
  clients, so an admin asking about a client they were not added to got their own reports back under
  that client's name. It now uses `clientAccess`, the same rule as everywhere else (new use-case test,
  which fails on the old code).
- The sign-in screen says *Sign in* and *Password* rather than *Authenticate Session* and *Access
  Key*.

## Not in this phase

The owner's portal and the report layout (stage 3), and plain-language names inside the tool pages
themselves. The **Lead Finder** and **Content Plan** pages are deliberately unchanged: the owner has
suggestions for both, and they are next after those arrive.

## Checks

`npm test` — 404 checks; the wiring audit now also scans `ui.js` for endpoint calls. The new pages
were also driven in Chromium against a mocked backend (every tab, New work, add-client, the board
with a drag, the task drawer, My tasks, a phone-width pass) with no page errors and no horizontal
overflow.
