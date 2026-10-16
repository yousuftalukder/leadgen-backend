# Phase 62 — documents on tasks, a tidier rail, and the site's look

## Run

1. **SQL.** Run `sql/schema-phase62.sql` in the Supabase SQL editor. It is idempotent and adds one table, `client_task_files`.
2. **Server (Render).** Deploy. The private storage bucket `task-files` is made on the first upload: 20 MB a file, PDF, Word and Excel types only.
3. **Pages (Netlify).** Deploy.

Until step 1 is run:

- Uploading a file answers 503 with "needs the phase-62 database update".
- Opening a task still works and shows no files.

## What changed

- **Documents on a task.**
  - A task's page has an **Attachments** section, where you can:
    - choose PDF, Word (.doc, .docx) or Excel (.xls, .xlsx, .csv) files, or drop them on the section;
    - download a file under the name it was uploaded with;
    - remove a file, if you attached it or edit the client.
  - **Limits:** 20 MB a file and 25 files a task. Each person can attach 40 files per ten minutes.
  - **What the server checks.** It decides what a file is from its bytes, not its name. An executable renamed `.pdf`, or a PDF renamed `.docx`, is refused.
  - **Downloads.** Files are only handed out as one-hour signed links, to people who can open the task.
  - **Deleting a task** deletes its files.
  - Pictures in a description work as before (phase 48).
- **The rail's account panel.**
  - The Apify key, AI key, Change password and Sign out controls now sit behind your name, in one menu at the bottom of the rail.
  - The menu closes on Escape or an outside click.
  - A dot on your name means a key is missing.
  - Rail links no longer get squashed when the list is long. They used to shrink and clip their labels; now the list scrolls.
- **The look.** The workspace now uses the EdgeLead site redesign's look:
  - **Palette:** black panels with white hairlines. Blue is for actions, and lime is for the one highlight on a screen.
  - **Type:** uppercase Space Grotesk for page and section headings, and Inter for text. Anek Bangla still covers Bangla.
  - **Logo:** the logo is unchanged.
  - **How it was done:**
    - The tokens in `app.css` `:root` carry the new palette. The old token names, such as `--jade` and `--accent-solid`, are kept, so every page keeps working.
    - A final block in `app.css`, "PHASE 62 :: THE SITE'S LOOK", sets the headings, buttons, inputs, cards and rail.
    - The gold and jade colours that were hard-coded in page styles were moved to the same palette.

## Check after deploy

- Open any task and attach a .xlsx, a .pdf and a .docx. Each one shows in the list and downloads under its own name.
- Try to attach a renamed .exe. It is refused with a message.
- Delete a test task that has a file attached. The file disappears from the `task-files` bucket.
- On a laptop screen, every rail link is full height. Your name at the bottom opens the account menu.
- Look at Home, Clients, a client's workspace, Team & settings and a report, on desktop and on a phone. Check for any gold or jade that was left behind.
