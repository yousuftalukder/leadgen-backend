# Phase 61 — every page draws after one trip to the server

## Run

No SQL and no server change. Deploy the pages (Netlify) only.

## What changed

Measured with 0.3 s added to every trip to the server, roughly a Dhaka-to-Render round trip:

| | Before | After |
|---|---|---|
| Most pages | 0.65 s | 0.35 s |
| Home, a client's workspace | 0.96 s | 0.35 s |

- **Who you are, remembered for the tab.**
  - Each page used to ask the server "who am I" and wait for the answer before asking for its own data.
  - Now the answer from the last page is used at once, and asked again behind the page.
  - A changed role or set of tools reloads the page. Signing out forgets it.
  - The server still checks every request itself, so a remembered copy can only draw a menu, never open anything.
- **The client list, remembered for a minute.**
  - Adding, changing, archiving, merging or removing a client clears it straight away.
- **Menu counts**, such as My tasks, show at once from the tab's copy and refresh behind.
- **Home** asks for everything it shows at once. It used to ask for recent reports last.
- **A client's workspace** asks for the client, its timeline and its board together. It used to ask for the client first.
- **Saving, moving or deleting a task** shows on the board and in My tasks straight from the server's answer, then the board re-reads itself quietly. It used to wait for the whole board to reload.

The first visit after the server has slept still waits for Render to wake (about 10–15 s). A paid Render instance stays awake. Long runs, such as audits and lead searches, still take minutes. They run on the server, and the page does not wait on them.

## Check after deploy

Open Home, then a client, then My tasks. After the first page, each one draws straight away. Sign out, sign in as someone else: their own name and menu show.
