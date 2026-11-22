# Phase 78 — the content plan, linked to the ad ledger and to the owner

## Run

1. **SQL:** run `sql/schema-phase78.sql` in the Supabase SQL editor. It is idempotent.
2. **Server:** deploys on Render by itself on merge.
3. **Pages:** deploy on Netlify by themselves on merge.

The server and pages work before the SQL has run. "Use as ad creative" then says the update is needed, and the team's posts are not shown to the owner yet. Everything else is as before. After the SQL, both switch on within a minute, with no redeploy.

## Why

A post the team typed into the Content plan, then ran as an ad, had to be typed again under Ad ledger → Creatives, and the two copies were not linked. The posts the team typed in also never reached the business owner. Only the content-plan tool's planned posts appeared in "Posts to approve".

## What changed

- **Use as ad creative:** a saved post in the Content plan tab has this button.
  - It makes the creative in the ad ledger from the post. The description's first line is the name; the type of post is mapped to the ad ledger's formats (Video reel → Reel, Static → Image, and so on); the date carries over; the description becomes the hook; the platform and caption go in the notes.
  - The creative is linked to the post, so pressing the button again returns the same creative.
  - The post's row shows an "Ad creative" tag, and the creative says which post it was made from.
  - When the post gets its link (posted), the creative gets it too, if it has none.
- **Posts to approve shows the team's posts.** The posts typed into the Content plan appear there beside the tool's planned posts, with the same Approve / Ask for changes / Skip:
  - It covers posts from two weeks back and undated ones, not skipped.
  - An undecided, still-planned post is "Waiting for your OK". Once the team marks it made or posted, it can no longer be decided.
  - The owner's answer is kept apart from the team's own status. The team sees it on the row ("Owner approved", "Owner asked for changes") and at the top of the post, with what the owner asked for.
  - The owner skipping a post skips it in the plan too.
  - The owner is never sent the team's notes.
  - Edge Meta AI's answers about upcoming posts include these posts too.
- **Columns** (`sql/schema-phase78.sql`):
  - `client_ad_creatives.content_entry_id`
  - `client_content_entries.owner_decision`, `owner_note`, `decided_at`

## Check after deploy

1. Content plan tab: open a saved post and press **Use as ad creative**. It appears under Ad ledger → Creatives, and the post shows "Ad creative".
2. Edge Meta AI, as the owner: **Posts to approve** lists the team's posts. Ask for changes on one, and the team sees "Owner asked for changes" with the note.
