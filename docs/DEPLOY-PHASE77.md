# Phase 77 — agency answers get follow-ups; the work has an Overview in the bar

## Run

There's no SQL. Deploy the server (Render does this by itself on merge) and the pages (Netlify, on merge).

## Why

Answers about the owner's numbers came with follow-up questions, as in the Owner Assistant. Answers about the agency's work came back with none. That includes the three questions the app itself suggests: "What are you working on for us?", "What do you need from me?" and "When is our next post?". The bar also had no single place showing everything the agency is doing.

## What changed

- **Follow-ups for agency answers,** about the work just listed:
  - "What exactly do you need for "<their first to-do>"?"
  - "Which posts are waiting for my OK?"
  - "When will "<work due soonest>" be ready?"
  - Then the general questions not yet asked.
- **The chat itself is unchanged.** The answer stays a conversation, with no work panel in it.
- **Overview**, first in the left bar, opens a sheet with all of the agency's work for the owner:
  - **Counts:** waiting on you, in progress, posts for your OK, reports. Anything waiting on the owner is highlighted. Each count opens its own sheet.
  - **Lists:** waiting on you, we are working on, planned posts (the ones waiting for an OK marked) and finished in the last 30 days. Due dates are shown, and overdue ones in red. Each row opens that to-do or task, or the posts sheet; Back returns to the Overview.
  - It is built from what the bar already loaded, so it opens at once, with no extra request or AI call.

## Check after deploy

1. Ask Edge Meta AI "What are you working on for us?". Up to three follow-up buttons appear under the answer.
2. Click **Overview** in the bar. The counts and lists match the to-dos, work and posts. Clicking a count or a row opens it.
