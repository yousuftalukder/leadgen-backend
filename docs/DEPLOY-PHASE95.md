# Phase 95: Front end, publishing blogs and work to the website

No SQL. One merge deploys the page (and one line of the server).

## Before it works: the website token (once)

Front end publishes through the server's phase-66 routes, which commit to the website's repository
(`yousuftalukder/Edge-lead-Front-end`) with a GitHub token. If Front end says **"Publishing to the website is not set up
yet"**, the token is missing or has expired:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
   - Repository access: only **Edge-lead-Front-end**.
   - Permissions: **Contents: Read and write**, **Commit statuses: Read**, **Checks: Read**.
2. Render → the backend service → Environment: set **`SITE_REPO_TOKEN`** to that token. It redeploys by itself.

`SITE_PUBLIC_URL` is no longer needed: the server now uses `https://edgelead.online` unless it is set.

## What changed

| Area | Now |
| --- | --- |
| The menu | **Front end**, under Owner next to Admin. Only the owner sees it; the server checks the owner on every call. |
| Works | Campaigns, products and other work: title, kind, status, category, summary, tags, the Work page's filters, a cover photo, up to four results, the service pages it shows on (with shorter wording for each), order, date, shown as a card or not, on the site or hidden. The list shows which ones the homepage picks (the first five, by order, with a photo). |
| Website works | Websites and apps we built: the same card, plus the live site for "Browse the real sites": name, address, colour, description, what it was built with, behind a sign-in or not, and a full-page screenshot per page (up to twelve; move them up, add, remove). |
| Blog | Title, excerpt, date, tag, author, a cover, and the text in Markdown with buttons for a heading, bold, italics, a list, a link and a picture placed in the text. Word count and reading time. A draft is saved to the website but stays off it. |
| Preview | Beside every editor: the card as it shows on the Work page, the live-site viewer (click through its pages), or the article as it reads. |
| Publishing | **Publish** puts it on the website in about a minute: one commit to the website's repository, then Netlify rebuilds. The status chip shows Building… → Live (or Build failed, with the log). Leaving with changes not published asks first. If someone else published the same item meanwhile, nothing is overwritten: the page says so and reloads their version. |
| Pictures | Shrunk in the browser (JPEG, at most 1.3 MB), uploaded one at a time, and go live with the Publish that uses them. A picture an item stops using is deleted in the same commit. |

## Files

- `frontend/app/website.js` (new): the page, loaded the first time Front end opens.
- `frontend/app/app.js`: the menu item, the owner-only route, the lazy load.
- `frontend/app/app.css`: the page's styles (`.fe-*`).
- `src/24-website.js`: the website's address defaults to `https://edgelead.online`.
- `tests/phase95.test.js`: the article preview lets no script or `javascript:` link through, and the wiring.

The pricing tables, results figures and site settings that the phase-66 page also edited are not on this page yet; their
routes (`PUT /api/site/services/:id`, `PUT /api/site/settings`) still work.
