# Phase 50 — in the app: a new check-up, and the chat before Meta is connected

## Run

**No SQL.** Deploy the server, then the pages (`meta-ai.js`, `meta-ai.css`, `owner-hub.js`).

## What changed

- **Chat without Meta.**
  - A business that has not connected Facebook and Instagram can now chat in Edge Meta AI.
  - It asks about its agency's work: what is being done, what is planned, what waits for the owner, and the next posts.
  - The assistant gets only the agency-work tool and its own short instructions.
  - It has no numbers. Asked about performance, it says it can answer as soon as Meta is connected, and points to the Connect button. It never guesses.
  - The welcome screen offers three agency questions with the Connect card under them.
  - While the first read runs after connecting, the same questions are offered.
  - Behind it, a business without Meta gets a bare, inactive Edge Meta AI record to keep its chats. The twice-daily read skips it, and it is not listed under Admin → Meta & Edge AI. The first Meta connection fills it in and switches it on.
- **New check-up in the app.**
  - The Updates row has **New check-up** for owners who have the check-up tool.
  - It is the same run the old owner home had: their Instagram, plus up to two similar businesses to compare with.
  - Progress shows in the panel, and the report opens in the app when it is done.
  - The handle is remembered for next time.

## Check after deploy

1. As an owner of a business without Meta, open the app and ask "What are you working on for us?". The answer comes from the shared tasks. Ask "how is my reach?": it says to connect Meta.
2. Open **New check-up**, enter a handle, and run it. The report opens in the app.
