# Phase 48 — tasks as proper issues: key, priority, pictures in the description

## Run

1. **SQL first:** run `sql/schema-phase48.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It is idempotent. It adds:
   - the task priority
   - the running task number behind each key
   - a longer description limit
   - the `client_task_media` table
2. Then deploy the server.
3. Then deploy the pages: `ui.js`, `app.css`, `header.js`, `client.html`.

The server creates the private storage bucket `task-media` itself on the first picture. Nothing to do in Supabase Storage.

## What changed

- **Opening a task** shows a wide issue view, like Jira:
  - **Left:** title, a description with pictures, a checklist with a progress bar, and the activity (comments).
  - **Right:** status, priority, assignee, labels, due date, whether the client sees it, and key / reporter / created / updated / done / where it came from.
- **Priority:** Highest, High, Medium, Low, Lowest, shown with an arrow on each card. Existing tasks are Medium.
- **Key:** every task gets one, made of the client's initials and a number (HC-12). It shows on the card and in the task.
- **Labels:** pick from the usual ones or type your own. Up to 8 per task.
- **Pictures:**
  - Paste (Ctrl+V), drag and drop, or use **Add picture** in the description and in comments.
  - A picture uploads the moment it's pasted and appears where the cursor was.
  - Big phone photos are scaled down first. The limit is 5 MB, as PNG, JPEG, WebP or GIF.
  - The server checks the bytes are really a picture.
  - Click a picture to open it full size.
- **Who can see the pictures:**
  - They are kept in a **private** bucket.
  - A page only ever gets a signed link that lasts an hour, from a route that has already checked the person may read the task. Staff on the client can see them; the owner only on tasks shown to them.
  - Pictures of one client can't be pulled into another client's task.
  - Deleting a task deletes its pictures too.
  - Merging two clients carries them over.
- **Owner's to-dos:** an owner's to-do now shows the pictures in its description.
- **Limits:** descriptions can be up to 20,000 characters and comments up to 4,000.
- **Tests:**
  - Four content-plan tests only passed after the 18th of a month. They seeded one post a day going back from today. They now pass on any day.
  - The fake Express in each test file gained `raw()`, which the picture upload route uses.

## Check after deploy

1. Open any client → **Tasks** → **New task**. Give it a priority and two labels, paste a screenshot into the description, and create it. The card shows the key and the priority arrow.
2. Open it again. The picture is there; click it to see it full size.
3. Turn on **Client sees it**. Sign in as the owner: the to-do shows the picture.
