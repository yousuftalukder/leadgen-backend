# Phase 39: the Facebook groups read as a document

## What to run

Nothing in SQL. Merge, and Render redeploys the server; Netlify publishes the pages.

## What changed

- `fbGroupsDoc(row)` builds the client document for a Facebook groups read
  (`fb_community`, several groups) and for a single group (`fb_group`), in the
  same layout as the Instagram, competitor and Facebook Page reports.
  `reportDoc` dispatches to it, so the owner portal, share links and
  `report.html` show it with no page changes.
- Sections: At a glance · Which groups are worth your time (ranked, with our
  call: work it / test it / skip it; thin samples marked) or, for one group,
  Is this group worth your time (what the score is made of, posting rules) ·
  What people are asking to buy · What gets a response here · Posts that did
  best · When and how to post (heatmap, best hours, posting playbook) · Group
  rules and risks · Turning this into customers (this week, 30-day plan) ·
  About this report.
- Group members are never named; post links are shown only when they point to
  facebook.com. Groups with no public posts are left out.
- The workspace report viewer's "Client report / Full analysis" toggle now
  covers both group report types (full analysis stays on `fb-audit.html`).
- `app.css`: quote tags wrap on narrow screens.
