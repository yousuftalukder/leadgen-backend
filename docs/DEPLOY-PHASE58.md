# Phase 58 — the older tool pages in the workspace layout

## Run

No SQL and no server change. Deploy the pages (Netlify) only.

## What changed

- **One page header everywhere.** The fourteen tool pages now open the way Home, Clients and a client's workspace do: a plain title and one line saying what the page is for, above the work. They used to put the title inside the first card.
  - Team & settings, Content plan, Creator posts, Post advisor
  - Community audit, Facebook communities, Demand feed, Facebook Page report
  - Competitor intel, Instagram audit
  - Lead list, Pipeline, Review tracker, Scheduled runs
- **Workspace cards and tabs.**
  - Inside the staff app, cards are flat, with no glass blur or glow line. Their titles are smaller.
  - Tab bars are underlined tabs, like a client's workspace. On a phone they scroll sideways instead of wrapping into a block.
  - Run buttons size to their label on a computer and go full width on a phone.
  - The styling is scoped to the staff app, so the owner pages and the report pages are unchanged.
- **"How it works" boxes start closed** on the four Facebook pages, so the form is the first thing you see. **Show** opens them.
- **Competitor intel works again.** The page's script stopped at its first line of setup: the run button, the tabs, saved sets and Reports did nothing. It now runs.
- **Scheduled runs:** the "Show" picker sits in one row with "show paused" and Refresh.
- **Lead list:** a partial summary from the server no longer stops the page drawing its tiles.

## Check after deploy

1. Open **Competitor intel**. Switch to Saved sets and to Reports; both load. The estimate box shows a dollar figure.
2. Open Lead list, Pipeline and Community audit on a computer and on a phone. Each has the title at the top, underlined tabs, and no sideways scrolling.
