# Phase 67 — connect every Page once, file each under its client

## Run

There's no SQL and no server change. Deploy the pages on Netlify, which happens by itself on merge.

## What changed

- **Clients → New → Connect your Facebook Pages.** This opens Facebook's window without naming a client. Tick every Page you manage (the agency's whole Business Manager) and continue.
- **On the way back, the server files Pages by the phase-57 rules:**
  - a Page that a live client already holds stays with that client;
  - every other Page waits in **Pages you manage, not filed yet** on the Clients page.
- **For each waiting Page:**
  - pick **File under an existing client…**;
  - or press **Make this a client**, which creates the client from the Page's name and Instagram handle and asks only what they do and where.

  Filing a Page starts that client's first Edge Meta AI read.
- **The return message** says how many Pages connected and how many still wait.
- **The Clients page's menus** no longer open half behind the left rail.

The per-client **Connect Meta** button still works as before. It files the Page that matches that client, and leaves the rest waiting.

## Check after deploy

1. As a Tester, go to Clients → New → Connect your Facebook Pages and tick several Pages.
2. Back on Clients, the Pages without a client are listed, each with a picker.
3. File one. It disappears from the list, and the client shows Meta as connected.
