# Deploy — phase 37

Stage 2 of the report formats: the **Facebook Page report** as an agency document. No SQL. Server,
then pages. Stands on phase 36 (`reportDoc`, the document renderer).

`fbDoc()` builds it from the saved `fb_page` report, single Page or versus one rival Page:

| Section | From |
|---|---|
| Cover: grade, rating and reviews, posts read, followers | public data |
| At a glance: median engagement per post, comments and shares per 100 reactions, posts a week (rival's for comparison), the state of the Page in one line | public data, AI |
| Page health: the 12-point Page checklist and how people react (warm, negative, beyond a Like) | public data |
| What you post, and what works: formats against the Page's typical post, what each post is for, video | public data |
| Best posts, quoted word for word, with reactions, comments, shares, views and a link | public data |
| Timing and momentum: day and hour, median engagement by month | public data |
| Against the rival (versus mode only): every measure with its leader, share of all engagement between the two, formats the rival wins with | public data |
| Recommendations by priority (critical, high, medium, low) and quick wins | rules, AI |
| What is working, what is not · 30-day plan and what we will watch (now against target) | AI |

Facebook posts have no photos to keep (the scrape returns none), so the best posts are quoted rather
than pictured. Links are shown only when they point at facebook.com.

The owner's portal, share links and `report.html` show it; the client's Reports tab opens Facebook
Page reports on **Client report**, with **Full analysis** one click away.

`npm test`: 429 checks, two new (the versus document and its leader per row, priority chips, links
kept to Facebook; the single-Page document and the owner's view). Driven in Chromium at desktop and
phone width: no page errors, no horizontal overflow.
