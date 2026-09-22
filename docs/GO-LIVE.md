# What is left to 100% — by owner

As of 22 September 2026. The vision is built; what separates it from *finished* is proof, and a
handful of decisions and actions only the owner can take. Each item names who can do it and about
how long it takes.

## Yours — and none of them are code

| # | Item | Time | What it unlocks |
|---|---|---|---|
| 1 | **Create one client-role account** (Admin → People → Add someone → Client, or `signup.html` with a second email) | 5 min | The entire client surface — four pages, the trial banner, the assistant, the money moment — rendered by a real client for the first time. Everything built for clients is unproven in production until this exists. |
| 2 | **Run `scripts/live-checks.js`** with that account and yours | 10 min | The three things only production can prove: quota races between two real accounts, job resume, and isolation. It has never been run against this deployment. |
| 3 | **Set the contact email and at least one way to pay** (Admin → Trial & plans) | 2 min | Until then a client who asks to continue is told the team has it — true — but not where to send anything. |
| 4 | **Add your employees as Testers on the Meta app** (App Dashboard → App Roles) and connect one Page | 10 min | The first real Meta connection. Everything downstream of Meta — the owner report, the monthly report, the owner assistant's numbers, the deletion callback — is walked in tests and has never run live. |
| 5 | **Fund an Apify key and run each engine once** against a real account | 1 hour | The six rows marked *built, never exercised*: the engines themselves. They spend credit, so no test starts one. |
| 6 | **Decide on lead-list resale packaging** — it is a legal call (Meta ToS, GDPR/CCPA; `leads` holds email, phone, WhatsApp) | your call | Then about half a day to build the packaging and export. The internal list is complete. |
| 7 | **Submit Meta App Review** once someone qualified has read `privacy.html`, `terms.html` and `data-deletion.html` | days–weeks, on Meta's clock | Only gates *public* self-serve Meta connection. Employees as Testers are unblocked now. |
| 8 | **Let GitHub Actions run** — settle the account's Actions billing or raise its spending limit, or make the repository public (Actions are free there) | 5 min | The CI workflow exists and is correct; GitHub refused to start it: *"recent account payments have failed or your spending limit needs to be increased"*. Until then a broken push still goes live unnoticed. |

## Mine — remaining engineering, in order

| # | Item | Time | Why |
|---|---|---|---|
| b | **Split `server.js` by domain** — pure file layout, no behaviour change | ~1 day | 16,000 lines in one file is the biggest engineering debt. Do it before another developer joins, not after. |
| c | **Outbound email** for "a client asked to continue" | ~half a day | Needs a mail provider decision first; there is no mail in the stack. Until then the admin sees it on their next visit. |
| d | **Per-industry scoring** | ~2 days | Beyond the original vision; one model grades a bakery and a B2B consultancy alike. Only if wanted. |

Done on 22 September 2026:

- **CI** (`.github/workflows/test.yml`) — every push runs the suite and the audit; a broken push no
  longer goes live unnoticed.
- **The content plan walked end to end** — the last engine that spends no credit; E12 moved from
  UNIT to E2E with the boost gate asserted on a real run.
- **The Render link serves the front end** — the brief asked for it; the Render root answered 404
  for every page until now (post-deploy check 1 in `DEPLOY-PHASE28.md`).

## What "100%" honestly means here

The 44 use cases in `USE-CASES.md` are built and reachable. 30 are walked end to end by tests that
drive the real server; the rest are proven in logic, provable only live, or partial by a decision
above. Nothing in the vision is missing except the resale packaging, which is waiting on item 6.

The gap is not features. It is that **no second human has ever used it**. Items 1–2 close most of
that in fifteen minutes.
