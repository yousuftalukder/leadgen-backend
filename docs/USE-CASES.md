# EdgeLead — the use-case model

Who uses this product, what each of them is trying to do, how the pieces connect, and — measured,
not claimed — how much of it is proven.

The status column is the point of this document. It means one specific thing per row:

| Mark | Meaning |
|---|---|
| **E2E** | Walked end to end by `tests/usecases.test.js` — real route handlers, in-memory database, the actor's own token |
| **UNIT** | The logic is covered by a phase test; the workflow around it is not |
| **BUILT** | Implemented and wired (the audit proves reachability), but no test exercises it as a flow |
| **LIVE-ONLY** | Can only be proven against the real deployment (`scripts/live-checks.js`, or Apify / Meta credit) |
| **PARTIAL** | Some of the use case exists |
| **NOT BUILT** | Nothing exists; the row says why |

---

## The actors

| Actor | Who they are | What they hold |
|---|---|---|
| **Admin** | Runs the agency's installation | Every engine, every client, the keys, the limits, the accounts |
| **Employee** | Works on the clients they are assigned to | The engines an admin granted; their own Apify key or the pool, per admin setting |
| **Client — trial** | Signed themselves up; 7 days | The trial engines, itemised caps and a dollar ceiling, the shared pool |
| **Client — paid** | Activated by an admin | Monthly caps; the same client surface |
| **Client — lapsed / suspended** | Trial ended, or disabled | Nothing; refused at the door with a code the page acts on |
| **Public viewer** | Someone holding a share link | One report, read-only, until the link expires or is revoked |
| **Scheduler** | The system, on a timer | Repeats a saved run under the client it was created for |

---

## How the pieces connect

Every arrow is a real column or link table. Nothing here is a concept the code does not have.

```mermaid
flowchart LR
    subgraph People
        ADM[Admin account]
        EMP[Employee account]
        CLI[Client account]
    end

    subgraph Business["Client record (the unit of work)"]
        C[(clients)]
    end

    ADM -- "owns / admin override" --> C
    EMP -- "owner or member<br/>(editor · viewer)" --> C
    CLI -- "owns (created at signup)<br/>or member (taken on by an agency)" --> C

    subgraph Work["Everything is filed under a client"]
        J[(jobs)]
        R[(reports<br/>ig · competitor · fb page · community<br/>content plan · meta owner · monthly)]
        CP[(campaigns)]
        MC[(meta_connections)]
        TH[(ai_conversations)]
        SC[(schedules)]
        SH[(report_shares)]
    end

    C --> J & R & CP & MC & TH & SC & SH

    subgraph Leads
        L[(leads<br/>master list · per owner)]
        CL[(client_leads)]
    end
    CP -- campaign_leads --> L
    C -- "for this client" --> CL --> L
    EMP -- "owner_user_id" --> L

    SH -- "token, no session" --> PUB[Public viewer]
    SC -- "re-runs under the same client" --> J
    MC -- "owner-only numbers" --> R
```

Three rules the arrows enforce:

1. **A run with no client is refused** (`400 client_required`). A client account is its own business
   and never has to choose; everyone else must. This is server-side; the pages only point at the
   picker.
2. **Scraped and owner-side numbers never blend.** Every report row carries its source; the monthly
   report and the owner assistant read Meta only; the audits read scraped data only.
3. **Access is by client, checked at every route.** Owner, member, or admin — `clientAccess` — and
   the public share link is the single deliberate exception, gated by its token.

---

## Admin

| # | Use case | Status | Proof / where |
|---|---|---|---|
| A1 | First account to sign in becomes admin (bootstrap) | **E2E** | `usecases` — *an agency starts up* |
| A2 | Create an account as employee, client or admin | **E2E** | `usecases` — *the admin provisions people*: the new hire signs in and sees exactly the engine granted; the walk-in client sees a trial and an allowance |
| A3 | Grant engines per employee; refuse an ungranted engine at its route | **E2E** | `usecases` — a grant added later shows on the next request; an ungranted engine is 403 at the route, not hidden in the page |
| A4 | Set trial length, trial caps, monthly caps — and have them bite | **E2E** | `usecases` — *the admin moves a limit, and it moves*: a changed cap is enforced on the client's very next request |
| A5 | Activate a paying client, set expiry, plan label; see who is waiting to be | **E2E** | `usecases` — *the money moment*: activation answers the request, evicts the stale auth cache, and the admin's pending count falls; the Admin nav carries the count |
| A6 | Create a client record | **E2E** | `usecases` — *the admin creates a client* |
| A7 | Assign an employee to **any** client, including one an employee created | **E2E** | `usecases` — *the admin can hand out work on a client an employee created* |
| A8 | See every client, with Meta connected / not | **E2E** | `usecases` — *the client row says whether Meta is connected* |
| A9 | Merge two records for one business | **E2E** | `usecases` — *one business, one record* |
| A10 | Manage Apify keys, the shared pool, Gemini keys | **BUILT** | admin.html *Apify keys*; phase-11 unit tests on key resolution |
| A11 | Check real Apify cost against the estimates; rotate the encryption key | **BUILT** (ops-only) | `docs/OPS-ENDPOINTS.md` |
| A12 | Watch spend and health | **BUILT** | admin.html *Spend & health*, `/api/admin/metrics` |

## Employee

| # | Use case | Status | Proof / where |
|---|---|---|---|
| E1 | See the clients I am assigned to | **E2E** | `usecases` — *the employee sees the client they were assigned* |
| E2 | Choose which client a run is for; be refused without one | **E2E** + rendered | `usecases` — *with no client chosen, a run is refused*; work-for bar verified in all three states |
| E3 | Run any granted engine — IG audit, competitor intel, FB page report, community audit, post advisor, content plan | **BUILT** / **LIVE-ONLY** | 13 workers, every one wired to a route and a page (audit); the run itself needs Apify credit |
| E4 | Find Instagram leads (five methods) and have them filed under the client | **E2E** (link) / **LIVE-ONLY** (search) | `usecases` — *for this client, these are the leads*; the worker links via `linkLeadsToClient` |
| E5 | Find Facebook Page leads | **BUILT** | Lead List → *Find Facebook Pages*; phase-16 unit tests on the row shape |
| E6 | Read the master lead list, filter it, export it | **E2E** | `usecases` — *the export never hands a spreadsheet a formula*; `phase20` for the sort whitelist |
| E7 | See **this client's** leads, found by anyone, one row per business | **E2E** | `usecases` — client view, colleague's find, de-duplication, stranger refused, export follows scope |
| E8 | Connect Meta as the client's Business Suite manager; turn a Page into a client | **E2E** (onboarding) / **LIVE-ONLY** (the OAuth handshake) | `usecases` — *an employee onboards a client from Business Suite*: unfiled Page → client with nothing retyped → filed, twice refused, colleague refused. The handshake itself needs a Tester role on the Meta app |
| E9 | Build the monthly owner report, this month against last | **UNIT** | `phase19` — month bounds, deltas, "new" vs "no baseline" |
| E10 | Ask the analyst about one client only | **E2E** | `usecases` — *the analyst answers about one client only*: the model is scripted, and the test reads what the server actually sent it — the tool result held only that client's reports, the prompt named the client and the scope, a thread will not take a turn about another client |
| E11 | Discover comparable local businesses; keep a stable comparison set | **UNIT** | `phase19` — size band, query shape |
| E12 | Write a content plan; add manual audit findings; only proven cells may be boosted | **UNIT** | `phase17` — the boost gate, tested adversarially |
| E13 | Share a report by link; revoke it | **E2E** | `usecases` — *a report goes out to someone with no account* |
| E14 | Repeat a run on a schedule, under its client | **E2E** (create, list, pause, delete; carries the client) / **LIVE-ONLY** (the timer firing) | `usecases` — *a run is repeated on a schedule, under its client*; `phase11` for next-run arithmetic |
| E15 | Bring my own Apify key; pause instead of using the pool | **E2E** (the own-key-only setting) / **BUILT** (the key itself) | `usecases` — own-key-only sticks; sidebar *Update key* |

## Client

| # | Use case | Status | Proof / where |
|---|---|---|---|
| C1 | Sign up → 7-day trial → I am my own business from the first login | **E2E** | `usecases` — *a business signs itself up* |
| C2 | See my reports in owner language — Instagram banded and ranked; Facebook, owner and monthly reports as headline, what is working, what to change | **E2E** | `usecases` — *the client surface names every kind of report*: titles for every stored type; a Page report and a monthly report open as points, with no invented standing; an Instagram report still bands and ranks |
| C3 | Draw a limited number of leads; audit a limited number of groups; stay under a dollar ceiling | **UNIT** | `phase13` — 32 checks on caps, periods, refunds |
| C4 | Ask the assistant | **E2E** | `usecases` — a client account is answered in the owner register, about itself, never told how it is built |
| C5 | Connect my own Meta and get the owner assistant | **BUILT** / **PARTIAL** | Works for accounts with a role on the Meta app. The privacy, terms and data-deletion pages and the deletion callback App Review asks for now exist; **public self-serve still needs the review itself** |
| C6 | Be taken on by an agency and see the work they do for me | **E2E** | `usecases` — *the agency takes that business on* |
| C7 | Lapse → refused with `account_expired`; be re-activated by an admin | **E2E** (refusal) / **BUILT** (activation) | `usecases` — *the account states a client can be in* |
| C8 | Purchase | **PARTIAL by decision** | Admin activates manually; no payment gateway |
| C10 | Ask to continue — during the trial or after it has ended — and be activated | **E2E** | `usecases` — *the money moment*: a trial client asks with a note; a **lapsed** client can still ask (the one door that stays open); the admin sees it waiting and activates; the very next request is in and the request is cleared. Rendered: the banner action, the expired screen's button, the "already asked" state |
| C9 | See the leads my agency found for me, marked as the team's | **E2E** | `usecases` — *the client sees the leads their team found for them* |

## Public viewer

| # | Use case | Status | Proof / where |
|---|---|---|---|
| P1 | Open a share link with no account; expired or revoked → 404 | **E2E** | `usecases` — share create → public read → revoke → 404 |
| P2 | Meta tells us someone removed the app; their connections and owner-side reports are deleted, and they can check the confirmation | **E2E** | `usecases` — *Meta asks us to forget someone*: wrong secret, tampered payload and garbage all refused; scraped reports untouched |

## System

| # | Use case | Status | Proof / where |
|---|---|---|---|
| S1 | Quota is consumed atomically; two runs cannot both see room | **UNIT** + **LIVE-ONLY** | SQL RPCs; `live-checks.js` proves the race with two real accounts |
| S2 | A job checkpoints and resumes; a paused run is not a hang | **LIVE-ONLY** | `live-checks.js` |
| S3 | One Render instance; a second one alarms | **LIVE-ONLY** | heartbeat guard, `/api/health` |
| S4 | Rate limits are per route: a page-load's reads never lock a job start; public traffic never locks the assistant | **E2E** | `usecases` — *rate limits do not bleed between routes*. Found by the assistant flow: every limiter shared one bucket by key, so six reads in a minute made the next job start a 429 |

---

## What is not built, and why

| Gap | Why it is where it is |
|---|---|
| **Payment gateway** | Your decision: admin activates manually. Right for an agency; a ceiling for "anyone can purchase". |
| **Meta App Review** | Only gates *public* self-serve connection. Employees, as Testers, are unblocked. The pages and the deletion callback it requires exist (`privacy.html`, `terms.html`, `data-deletion.html`, `POST /api/meta/data-deletion`); the submission itself, and a review of the page wording by someone qualified, are still to do. |
| **Per-industry scoring** | One scoring model for every niche. A bakery and a B2B consultancy are graded the same way. |
| **Lead-list resale packaging** | Held on your legal call. The internal list is complete. |
| **Un-merge** | Merge is one-way by design; the archived record keeps a note naming where it went. |

---

## The measurement

| Suite | Checks | What it proves |
|---|---|---|
| `tests/usecases.test.js` | 86 | The workflows above marked E2E, as a person would do them — including the assistant, against a scripted model whose every request the test reads back |
| `tests/wiring.test.js` | 36 | Every page reaches a real route, every worker is startable, every engine grantable, every job page carries the client bar |
| `tests/phase*.test.js` | ~200 | The logic inside each engine |
| `scripts/live-checks.js` | — | The things only production can prove: quota races, resume, isolation between two real accounts. **Has never been run against this deployment — it needs a second account.** |

**How the counting is kept honest:** the runner treats a test file that exits cleanly without a result line as a failure. It did not always; when `server.js` once threw at load and its crash handler exited 0, eleven files reported "ok" having run nothing. The server now exits non-zero on any exception before boot completes, so that state cannot deploy either.

**Where the model is still unproven in production:** no engine has been run end to end inside a
test (they spend Apify credit), the client surface has never rendered for a real client-role
session, and Meta has never completed a connection. Everything in the E2E column has a second human
in the loop *inside the test*; nothing yet has one outside it.
