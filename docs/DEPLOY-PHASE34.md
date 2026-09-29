# Deploy — phase 34

The client-first workspace, stage 3: **the report a client reads**, and the owner's portal. The monthly
report becomes the document an agency sends, the same one on the staff page, in the owner's portal,
on a share link and on paper. The owner's home gains their to-dos and a view of the agency's work.

**No SQL.** Server, then pages. It stands on phase 32 (`sql/schema-phase32.sql`) for tasks; without
that table the report still opens, with no "what we did" tasks in it and "Add to tasks" saying so.
If the pages go out before the server, the monthly page says the report is being upgraded and asks
for a reload; the portal and share links show every other report as before.

## The monthly report, as an agency sends it

`monthlyView()` turns a saved monthly report into one document, worded once on the server:

| Section | What it says | Source |
|---|---|---|
| Cover | The business, its accounts, the dates covered, when it was prepared | the report |
| 01 The month in brief | Three cards (visibility, audience, action), each a headline and a sentence with both months' numbers; the verdict; the summary | Owner Insights |
| 02 Scorecard | Every measure, this month and last, the exact change (`+5,824 (+18%)`), a status (`Growing` at +10%, `Watch` at −10%, else `Steady`; `New` from zero; `Small numbers` under 50 both months) | Owner Insights |
| 03 Your content | What worked and what did not; the best posts with reach, saves, shares and a link; which format reached most and least (medians) | Owner Insights |
| 04 Who you reach | Age, gender, cities, countries as shares of the followers Meta classified, and the one sentence that sums them up | Owner Insights |
| 05 Against similar businesses | Where they stood in the latest comparison **built before the report**, labelled with its date | Public data, kept apart |
| 06 What we did | Tasks finished that month **that the client is shown**, reports delivered, leads found | The agency's own records |
| 07 What we recommend | Priority, action, why, expected result (an estimate), who: "You" or "Our team" | The written report |
| 08 About this report | Where the numbers come from, what Meta did not report, caveats | the report |

- **The wording is precise on purpose.** A count from zero is "against none in July", never a
  percentage. The largest age group is "the largest group", never "most". A measure under 50 either
  month is given as a count, not a percentage (rule 5). Under 10% keeps its decimal.
- **A report does not change after it is sent.** Standing, work and leads are read as of the
  month covered and the report's own date: a comparison built later is not used.
- **Nothing internal reaches the client.** Tasks appear only when marked for the client; the tests
  check that an internal task never reaches the owner's view or a share link.
- **Recommendations are structured from now on.** The model is asked for action, why, expected
  result, who and priority; `cleanMonthlyAi()` keeps them to that shape and still writes
  `next_month` for older readers. Reports built before this phase show their lines as a list.

## For the team

- `monthly.html` shows the document, with **Save as PDF**, **Share link** and **Repeat on a schedule**.
- Each recommendation has **Add to tasks**: it goes on the client's board once, visible to the
  client, and one marked "You" becomes the owner's to-do in their portal. Once added, the button
  shows the task's status and opens the board.
- No monthly report yet? The page says how to build one and links to the client's Meta tab
  (it used to point at "the Analyst").

## For the business owner

- `client.html` is now **Home**: a greeting, their daily numbers, **Your to-dos** (tick them off;
  the agency sees it on their board), **What we are working on**, and their reports in the same
  layout as the agency's.
- The menu reads **Home, Ask AI, Find customers, Local demand**.
- The Apify status and the key buttons are the team's tools. An owner sees them only when an admin
  has made their runs spend their own key (`/api/me` now says `ownKey`).
- Fixed: the report list's names were near-black on the dark cards (a button does not inherit
  colour).

## Paper

`app.css` has print rules for the first time. On paper every page turns light and the app around the
content (menu, banners, buttons, the task column) is left out. The report keeps its sections whole
where it can and repeats table headers across pages. **Save as PDF** is the browser's own, so the
text stays sharp and selectable, and links to posts still work in the PDF.

## Shared pieces

- `report-view.js` (new): `ELReport.monthly()`, `ELReport.standard()` (every other report type in the
  owner's words: standing, post ideas, groups, what is working, profile gaps, summary),
  `ELReport.owner()` (picks one), `ELReport.wire()` (Add to tasks). It computes no number.
- `share.html` and `client.html` use it, so the two copies of the owner's report layout are gone.
- `CLIENT_REPORT_TITLES` moved to module level; the wiring audit reads it there.
- The service worker caches `report-view.js` with the portal (`el-shell-v2`).

## Checks

`npm test`: 413 checks, including ten new use-case tests (the brief's wording, the scorecard's
arithmetic and statuses (a doubling of three is not growth), the audience shares, the work log's visibility and month, standing as of the
report, the share link, the board state, what the model returns, the owner's key flag). The pages were
driven in Chromium against a mocked backend fed by the real `monthlyView()`: staff page, Add to tasks,
print and a generated A4 PDF, phone width, empty state, both share layouts, and the portal with a
to-do ticked. No page errors, no horizontal overflow.
