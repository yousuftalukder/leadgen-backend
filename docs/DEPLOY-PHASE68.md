# Phase 68 — the team hears about its tasks by email

## Run

There's no SQL. Deploy the server on Render, and the pages on Netlify (which happens by itself on merge).

**Mail must be set up**, under Admin → Trial & plans → Email (a Gmail address and its app password). Press **Send a test email**. Without mail set up nothing is sent, and nothing breaks. The same Gmail also sends the business owners' 6-digit sign-in codes. **Without it, owners cannot sign in to Edge Meta AI at all.**

## What changed

- **Given a task: an email at once,** to the person it was given to. This applies when a task is made with them on it, or reassigned to them. Subject: "New task for you: …".
- **A task changes: one email a couple of minutes later,** to whoever holds the task and whoever raised it. Subject: "Task updated: …". Every change in that window goes in one email:
  - the status moved;
  - the due date, title, priority, description or checklist changed;
  - someone on the team or the client commented;
  - a file was attached;
  - the client ticked their to-do.
- **Who never gets one:** the person who made the change, business owners (they have Edge Meta AI) and disabled logins.
- **Every email links to the task.** `workspace.html?client=…&tab=tasks&task=…` opens the client's board with that task open.
- **Mail never holds up a save.** A save never waits on Gmail and never fails because of it.
- **Batches live in memory.** A restart inside the two-minute window loses that one batch; the board still has everything.
- **`TASK_EMAILS=off` on Render** switches task emails off.

Gmail sends about 500 messages a day from a personal account. If the team grows past what that covers, move to a sending service; only `sendMail` would change.

## Check after deploy

1. Give a task to a colleague. They get "New task for you" within a minute.
2. Move it to In progress and add a comment. About two minutes later, they get one "Task updated" email listing both.
3. The link in the email opens the task.
