# Phase 85 — the ad brief and the ad plan

A client's new tab, **Ad brief & plan**, puts everything needed to plan the next ad set on one page, in a fixed order. A person reads it top to bottom, or Claude reads it in a browser. A plan made from it is saved under the client, approved, and then built in Ads Manager by hand. Nothing here creates or changes anything in Meta.

## Run

1. In the Supabase SQL editor, run `sql/schema-phase85.sql`. It adds four tables (`xp_meta_ad_sets`, `xp_ad_breakdowns`, `client_ad_briefs`, `client_ad_plans`), and is safe to run twice.
2. Merge. Render (the server) and Netlify (the pages) deploy by themselves.
3. Past ad sets fill in on the next ads sync (09:00 and 21:00 UTC), or straight away from admin → Ads.

Until the SQL is run, the tab says to run it. The ads sync logs the missing tables as errors and carries on.

## What changed

**The ads sync reads two more things from Meta**, with the `ads_read` permission it already had:

- **Each ad set's settings:**
  - Optimisation goal, billing event, bid strategy and amount.
  - Daily or lifetime budget, converted from cents into the account's currency.
  - Destination (Messenger, WhatsApp, website…), and start and end dates.
  - The full targeting: places and radius, ages, genders, interests, exclusions, custom audiences, Advantage+ audience, and placements.
- **The last 90 days of each ad set, split one way at a time:** by age and gender, by region, and by placement. The splits are replaced on every sync.
- Ad sets read before this phase are picked up once, on the first sync after deploy.
- An ad set that shows more than one business's ads belongs to none, as with campaigns.

**The Ad brief page**, in this order:

1. **Still missing:** what the page can't tell yet, in plain words.
2. **The brief:**
   - Goal, monthly budget, offer and when it ends, products to push.
   - Where they sell, how orders come in, WhatsApp, website, Pixel and catalog.
   - Who buys, busy times, what to avoid, what worked.
   - A box for what was seen on the page and in Meta's Ad Library, with Ad Library links for the business and its competitors.
3. **The business:** what the agency has, and what the owner filled in (phase 84).
4. **Products and margins**, from the Ad ledger.
5. **Who follows them:** followers and engaged people by age and gender and by city, the latest reading.
6. **Past ad sets:** each one as it was set up, next to what it cost and returned, busiest first.
7. **Who the ads worked for:** the 90-day splits.
8. **Ads the team logged**, with their verdicts and lessons.
9. **What similar businesses pay:**
   - Medians over 3 or more of the agency's other businesses with ads in the last 90 days.
   - It looks for the same kind of business in the same city first, then the same kind, then the same city.
   - It only uses businesses the person can open anyway, never names one, and never counts the business itself.
10. **Ad plans.**

Each part has a heading and an id (`#ab-brief`, `#ab-adsets`…). **Copy as text** copies the whole brief as one block, to paste into a chat or a document.

**Plan an ad set:**
- **The campaign:** objective, daily or lifetime budget, dates and a short summary.
- **Up to 6 ad sets:** locations and radius, ages, genders, languages, interests, exclusions, custom and lookalike audiences, Advantage+ audience, placements, optimisation, destination, schedule, bid, and why.
- **Up to 8 creative ideas:** format, angle, hook, primary text, headline, button, product, language, and why. These are suggestions; the team makes the media.
- **Rules:** target cost per result, when to stop, when to scale, the first check, and what the plan is based on.
- A new plan starts from the brief: the objective comes from the goal, and the daily budget is the monthly budget divided by 30.

**Who does what:**
- Editors write and change plans. The client's owner or an admin approves, rejects, or marks a plan launched.
- A plan can only be marked launched once it is approved.
- Changing an approved plan makes it a draft again.
- Business owners have no route here.

**Server:**
- New part `src/23-ad-brief.js`.
- The runtime part moves to `src/24-runtime.js`; it must stay last.

## Not covered

- Nothing is written to Meta. Building the ad set stays a person's step in Ads Manager.
- The Ad Library and the page itself are looked at by hand. The page has a place to note what was seen.
- Benchmarks come only from the agency's own clients. There is no outside industry data.

## Check after deploy

1. Run the SQL and merge. In admin → Ads, sync now.
2. Open a client whose ad account is shared → **Ad brief & plan**. Past ad sets show their targeting and budget beside their results, and the splits show by age and gender, region and placement.
3. Fill in the brief and save. The "Still missing" list gets shorter.
4. **Plan an ad set**, then save it as a draft. As the client's owner or an admin, approve it.
5. **Copy as text** and paste it somewhere: the whole brief is there.
