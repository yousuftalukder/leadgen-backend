# Phase 77 — agency answers get a panel and follow-ups

## Run

There's no SQL. Deploy the server (Render does this by itself on merge) and the pages (Netlify, on merge).

## Why

Answers about the owner's numbers came with chart panels and follow-up questions, as in the Owner Assistant. Answers about the agency's work came back as bare text. That includes the three questions the app itself suggests: "What are you working on for us?", "What do you need from me?" and "When is our next post?". `get_agency_work` had no panel builder and no follow-ups.

## What changed

- **A work panel** sits under every answer that read the agency's work:
  - **The counts:** waiting on you, in progress, posts for your OK, finished in 30 days. Anything waiting on the owner is highlighted.
  - **The lists:** waiting on you, we are working on, planned posts (the ones waiting for an OK marked) and finished lately. Due dates are shown, and overdue ones in red.
  - It is built from the tool's own rows. Work not shared with the owner never appears.
- **Follow-ups** about that work:
  - "What exactly do you need for "<their first to-do>"?"
  - "Which posts are waiting for my OK?"
  - "When will "<work due soonest>" be ready?"
  - After those, the general questions not already asked.
- **Reopened chats** rebuild both, as they do for numbers answers.

## Check after deploy

Ask Edge Meta AI "What are you working on for us?". Under the answer there is the "Your agency's work" panel, and up to three follow-up buttons.
