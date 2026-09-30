# Phase 46 — ads and creator posts in Edge Meta AI

## Run

No SQL. The tables were created in phase 31. Deploy the server, then the pages (`creators.html`, `workspace.html`, `privacy.html`, `data-deletion.html`, `app.css`).

**Before deploying:** if Render has a `META_SCOPES` variable, delete it. Otherwise the new `ads_read` permission is not requested.

## What changed

- **Ads.** The Facebook login now asks for `ads_read`, which is read only. After an owner reconnects, the twice-daily read also collects the results of ads that run as their Page or Instagram account: spend, reach, clicks, messages, leads, purchases and return on ad spend, per ad and per day. The ad accounts must be shared with the Facebook login that connected. Edge Meta AI answers questions about ads from this data. `ads_read` needs Meta App Review.
- **Creator posts.** Once a week, after the scheduled read, EdgeLead looks at the business's Instagram tagged tab and the collabs on its grid. The first look goes back 90 days; later looks cover only what is new.
  - It runs on EdgeLead's own Apify keys (engine "Reports & competitors"), with the same budget gate and spend ledger as every engine.
  - A collab, or a post from a creator with 1,000+ followers or 1,000+ views, is shown straight away. A post that looks like a customer's stays hidden until staff show it.
  - The numbers on shown posts are refreshed while they still change.
  - Only shown posts reach the owner's answers.
- **New staff page, `creators.html`.** Open it from the client's Ask AI tab → **Creator posts**. It lists shown and hidden posts, and lets staff:
  - look for new posts now, or refresh the numbers
  - add a post by its link
  - show or hide a post
  - record its cost and visit date. Edge Meta AI then answers with cost per 1,000 views.
  - Owners cannot open it.
- **Fixed:** XPulse's creator-post code read joined rows under table names that lost their `xp_` prefix, so the creator listing and the weekly pass came back empty. The joins now read the real names. An admin alert that names the business behind an expiring token had the same fault; it is fixed too.
- The privacy and data-deletion pages now describe the ad results and creator posts.

## Check after deploy

1. Reconnect one client's Meta, and share an ad account with that login.
2. Next morning, ask Edge Meta AI "How did our ads do this week?"
3. Open the client's **Creator posts** page and press **Look for new posts now**.
