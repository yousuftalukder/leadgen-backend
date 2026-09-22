# What is left to 100% — by owner

As of 22 September 2026, after the owner's answers of the same day. The vision is built; what
separates it from *finished* is proof, and a few actions only the owner can take. Each item names
who can do it and about how long it takes.

## Yours — and none of them are code

| # | Item | Time | What it unlocks |
|---|---|---|---|
| 1 | **Create one client-role account** (Admin → People → Add someone → Client, or `signup.html` with a second email) | 5 min | The entire client surface — four pages, the trial banner, the assistant, the money moment — rendered by a real client for the first time. Everything built for clients is unproven in production until this exists. |
| 2 | **Run `scripts/live-checks.js`** with that account and yours | 10 min | The three things only production can prove: quota races between two real accounts, job resume, and isolation. It has never been run against this deployment. |
| 3 | **Set the contact email, a way to pay, and your Gmail** (Admin → Trial & plans) — then press *Send a test email* | 5 min | Until then a client who asks to continue is told the team has it — true — but not where to send anything, and nobody is emailed. |
| 4 | **Add your employees as Testers on the Meta app** (App Dashboard → App Roles) and connect one Page | 10 min | The first real Meta connection. Everything downstream of Meta — the owner report, the monthly report, the owner assistant's numbers, the deletion callback — is walked in tests and has never run live. |
| 5 | **Fund an Apify key and run each engine once** against a real account | 1 hour | The rows marked *built, never exercised*: the engines themselves. They spend credit, so no test starts one. |
| 6 | **Submit Meta App Review** once someone qualified has read `privacy.html`, `terms.html` and `data-deletion.html` | days–weeks, on Meta's clock | Only gates *public* self-serve Meta connection. Employees as Testers are unblocked now. |
| 7 | **Make the repository public** (you said you would) | 5 min | GitHub Actions run free on public repositories, so the CI that exists starts running. The history was scanned before this was suggested: the only key-shaped string in any of the 86 commits is the Supabase *anon* key, which is public by design and gated by RLS; no `.env`, no service key, no Apify, Gemini or Meta secret was ever committed. |

## Settled on 22 September 2026

| Was | Now |
|---|---|
| "Lead-list resale packaging — half a day, on your legal call" | Never wanted. What was wanted was **one place**: every lead anyone collects, filed by industry and location. Built (phase 29): the `leads_master` view, the two columns, the backfill, the page. |
| "Outbound email — needs a mail provider decision" | **Gmail with an app password**, set in the admin panel. Built (phase 29) with three messages and a test button. |
| "Split `server.js` by domain before another developer joins — a day" | **No developer is joining.** Dropped. If that changes, it is the first day's work, and nothing else waits on it. |
| "Let GitHub Actions run — billing" | You are making the repository public instead. Same effect, no card. |

## Mine — what could still be built, none of it in the vision

| Item | Time | What it is |
|---|---|---|
| **Per-industry scoring** | ~2 days | Today one scoring model grades every account: the same engagement bands, the same "what good looks like", whether it is a bakery or a B2B consultancy. Per-industry scoring keeps a benchmark per niche (built from the accounts already scraped in that niche) and grades each client against *its* peers — so a 2% engagement rate reads as strong for a car dealer and weak for a cake shop. The comparison set already does this for one client against its named rivals; this would do it for every score on every report. Only if the reports feel unfair to a kind of business. |

## What "100%" honestly means here

The 45 use cases in `USE-CASES.md` are built and reachable. 32 are walked end to end by tests that
drive the real server; the rest are proven in logic or provable only live. Nothing in the vision is
missing.

The gap is not features. It is that **no second human has ever used it**. Items 1–3 close most of
that in twenty minutes.
