# Phase 43 — the content plan the way the agency works

## Run, in this order

1. **SQL:** run `sql/schema-phase43.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It is idempotent. It adds:
   - `content_profiles`: the business, as audited and corrected.
   - `content_topics`: topics by category.
   - `content_ideas`: the shared idea library.
   - `content_picks`: the month's picks.
   - On `content_posts`, `report_id` becomes optional and there is a new `pick_id`, so a calendar post can come from a pick.
2. **Server:** deploy (merge; Render deploys). Until the SQL has run, the new routes answer 503 with `migration_required`, and the boot schema check names phase 43.
3. **Pages:** Netlify deploys `content-plan.html`, `content-strategy.js`, `content-calendar.js`, `app.css` and `ui.js`.

## What changed

The Content Plan page now opens on **This client's plan**. It has three tabs:

- **This client's plan** has five steps:
  1. **The business.** "Audit the business" reads the website (home, plus up to 3 menu, services or pricing pages) and the Instagram posts already collected. Nothing is scraped, so there is no Apify cost. Gemini then fills in the summary, business model, audience, voice, offers with prices, what sets them apart, and proof. Staff can edit all of it. A later audit never overwrites what the team corrected; it offers "Use the audit's version" instead.
  2. **Topics by category:** Services (one per offer, ticked), Educational, Reviews and growth, Generic and Influencer collab. Each topic has a tick box, a priority, where it came from (audit, rivals, reviews, team) and why it is there. Topics can be added and removed. When the review tracker has found reviews of this client, it adds a "Happy customers" topic. Rival topics that score well in the newest scorecard become educational topics.
  3. **Ideas from the library.** For each ticked topic, up to 3 library ideas are shown, ranked by:
     - the post type the category needs
     - the format rivals win with
     - matching tags and words
     - a penalty for an idea already used for this client, and a bigger one if already picked this month

     "Suggest ideas with AI" has Gemini choose from each topic's own shortlist only, marking fit as good or weak and adding a one-line adaptation and up to 3 tools. Any idea the model invents is dropped. "Plan it without a library idea" is also available.
  4. **This month's plan:** the picks, with category, topic, idea, type (Static, Carousel, Video or **Story**) and tools. A pick opens a drawer for the team's own idea, script and style notes. **A pick cannot be marked final without one of those notes.** "Put final picks on the calendar" creates the posts. The **owner approves posts only**, from their portal as in phase 42, and an approved post becomes a task that lists its tools.
  5. **What works in this market:** from the client's newest scorecard. Shows format share and score for the client vs its rivals, the best hour, rival topics that work, and gaps.
- **Idea library** is shared by the whole staff team; owners never see it. You can:
  - add a link with where it was seen, the industry, post type (read from the link if left blank), hook, why it worked, style, tools and tags
  - filter by type, tag or "saved by me", and search
  - edit or remove an idea (only the person who saved it, or an admin, can remove it)
  - **import a spreadsheet** (CSV file or pasted cells). Columns are matched by name, "Check" shows the mapping first, and links already in the library are skipped.
- **Scorecard vs rivals** is the existing plan builder, unchanged.

The system chooses topics and suggests ideas. It never writes the post.

## Check after deploy

- Content Plan → Idea library → import your journal. Check the mapping, then import.
- For one client: Audit → tick topics → Suggest ideas → pick → add notes → Save as final → Put on the calendar. In the client portal, the post should show "Waiting for your OK".
