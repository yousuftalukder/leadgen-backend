# Deploy — phase 36

Stage 1 of the report formats signed off on Sep 29: **post photos kept**, and the **Instagram audit**
and **competitor intelligence** as agency documents. No SQL. Server, then pages.

## Post photos

Instagram's image links expire within days, so a report that showed them broke before the client
opened it. When an Instagram audit or a competitor benchmark finishes, the photos of the posts it
shows (the client's best, weakest and exemplar posts, and each rival's top two) are copied into
Supabase Storage and the report keeps that copy (`image` on each post card; the original
`thumbnail` stays).

- **Bucket:** `report-media`, public read, 2 MB per file, JPEG/PNG/WebP only. The server creates it
  the first time it needs it; nothing to set up. `REPORT_MEDIA_BUCKET` renames it if ever needed.
  Public is deliberate: these are photos of public posts, and a report or share link must show them
  without signing in.
- **Only Instagram's and Facebook's image hosts** (`*.cdninstagram.com`, `*.fbcdn.net`) are fetched.
  The address comes from a scrape, so anything else is refused before any request is made.
- A photo that cannot be copied is simply left out: the card shows its labelled panel instead.
  Reports built before this phase have no copies and show the panels.

## The documents

`reportDoc()` builds the page-by-page document for a report on the server; `report-view.js` draws
it (`ELReport.document`). Every section names its source (public data, owner data, our records,
written by AI), and a section with no data is left out rather than drawn empty.

| Report | Sections |
|---|---|
| Instagram audit (`ig_report`) | Cover with grade, score, posts read, followers · At a glance · How the score is built · What you post, and what works · Best and weakest posts (photos) · When your audience responds · Consistency and momentum · Hashtags and your profile · What is working, what to fix · 30-day plan and targets · About |
| Competitor intelligence (`deep_audit`) | Cover with overall, engagement and volume rank · The leaderboard · Where the gaps are · The format battle · Rivals' best posts (photos) · Hashtags they use and you do not · What this means · 30-day plan · About |

Where they appear:

- **Owner's portal** and **share links**: automatically, for these two report types.
- **Staff**: `report.html?report=<id>` (new) shows the document with Save as PDF, Share link and
  Repeat. In a client's Reports tab the viewer opens these two types on **Client report**, with
  **Full analysis** (the engine page) one click away.

## Checks

`npm test`: 427 checks, including six new use-case tests (only Instagram's hosts are fetched; one
copy per photo, shared by the cards that show it; the audit document's sections, headline rate,
kept photos and reliable caption lifts only; empty sections left out; competitor ranks and the
client marked; the owner and share link get the document and the assistant does not). Both
documents were driven in Chromium from the real `reportDoc()` at desktop and phone width and
printed to A4: no page errors, no horizontal overflow.

Next: phase 37 (Facebook Page report), phase 38 (monthly report with and without Meta).
