# Phase 59 — Websites, and filtering tasks by label

## Run

No SQL: tasks already carry labels (phase 32). Deploy the server (Render), then the pages (Netlify).

## What changed

- **Websites, in the menu.**
  - A new menu entry between Pipeline and Schedules.
  - It lists every task labelled **Website**, on every client you can open, whoever it is assigned to. Admins see every client. Archived clients drop out.
  - Grouped by client. Show Open, Waiting on client, or Done in the last 30 days, for every client or one.
  - A client's name opens its board, already filtered to Website.
- **Website work is always for a client.**
  - **New website work** asks which client first. With no client to add work to, it sends you to add one.
  - The task opens already labelled Website, on that client's board.
  - New work on a client has a **Build websites → Website work** entry that goes straight to the new task.
  - The server has no way to make a task without a client.
- **It is also in tasks.**
  - Website work is an ordinary task. It is on the client's board, and in **My tasks** for whoever it is assigned to.
- **Filter by label.**
  - My tasks and every client's board have a **Label** row: Any, Website, Content, … with counts.
  - My tasks keeps the choice in the address (`my-tasks.html?label=Website`), so a link opens it filtered.
  - On a board, a task added while a label is chosen carries that label.
- **Labels are filed one way.** A typed `website` (or `WEBSITE`) is saved as **Website**, and the same goes for the other suggested labels, so one filter finds them all.
- **New route:** `GET /api/tasks?label=Website`. Staff only.

## Check after deploy

1. The menu has **Websites**. Press **New website work**, pick a client, and create a task. It is listed under that client with the Website label.
2. Assign it to yourself. It is in **My tasks**, and pressing **Website** in the Label row filters to it.
3. Open the client's board from the Websites page. The Label row has Website chosen.
