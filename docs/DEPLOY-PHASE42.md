# Phase 42: the content plan as a calendar the owner approves

## What to run, in order

1. **SQL:** run `sql/schema-phase42.sql` in the Supabase SQL editor (creates
   `content_posts`). Idempotent.
2. **Server and pages:** merge; Render and Netlify redeploy.

Before the SQL, the plan page shows a message on the Calendar tab and the
owner portal shows nothing new; everything else works as before.

## What changed

- **Content Plan → Calendar tab:** "Put on the calendar" turns the plan's
  briefs into posts on dates. A brief keeps its own weekday and time where it
  names one ("Tue 7pm"); the rest are spread over four weeks, one a day at
  most. Pressing it again adds only briefs not already on it.
- Each post: date, time, hook, caption, the brief (concept, shot, script,
  why, proof), and a status: Waiting for approval → Approved → Made → Posted
  (or Changes asked, Skipped). The link once posted is kept.
- **Owner portal home → "Posts planned for you":** the owner approves, asks
  for changes (with a note, which the team sees on the card) or skips each
  post. Nothing about the team or the plan's internals is sent.
- **Approved → a task** on the client's board ("Make the reel: …", due two
  days before, with the shot, script and caption in its notes), once. Posted
  closes the task.
- **Monthly reports** (with Meta and without) gain "What we planned, and how
  it did": planned, approved, posted, and each posted post's public likes and
  comments, with the owner's Meta reach beside them where connected — side by
  side, never added together.
