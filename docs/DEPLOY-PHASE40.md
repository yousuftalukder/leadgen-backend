# Phase 40: who a lead is, and the pipeline

## What to run, in order

1. **SQL:** run `sql/schema-phase40.sql` in the Supabase SQL editor. It adds the
   sorting columns to `leads` (including the generated `kind_now`), rebuilds the
   `leads_master` view so it carries them, and creates `lead_pipeline` and
   `lead_notes`. It is idempotent.
2. **Server:** merge; Render redeploys.
3. **Once, as an admin:** on the Leads page press **Sort every lead again**
   (under the list). Leads collected before today are "unsure" until then. It
   costs nothing: no Apify, no AI.

Deployed before the SQL, the server keeps finding and saving leads exactly as
before; only the sorting and the pipeline wait for it.

## What changed

- **The search methods are unchanged.** After them, every lead is sorted into
  influencer, business, ordinary account (personal) or unsure, with the reasons:
  - at discovery, free, from the posts already paid for: review-style or selling
    captions (English and Bangla), ratings, the paid partnership label, how many
    places they post from, who they tag, and how many businesses' tagged posts
    they turn up in;
  - at enrichment, from the profile: Instagram's category, the bio, the website,
    a business address, the name.
- **Fit score (0–100)** for its kind: influencers on size, engagement for their
  size (low engagement for a big account is flagged), how many methods found
  them, businesses they tagged, contact and recent activity; businesses on
  contact, activity, size, weak engagement and no website.
- **"Is this right?"** A person's correction wins and is kept apart from the
  rules, and `GET /api/leads/accuracy` reports how often the rules agree.
- **Pipeline** (`pipeline.html`, in the menu): influencers are worked for a
  client brand (Found → Contacted → Rates asked → Agreed → Content live → Paid),
  businesses for the agency (New → Contacted → Replied → Meeting → Won/Lost).
  One row per lead per brand, so two people cannot chase the same shop
  unknowingly. Owner, follow-up date, rate, notes with an automatic history,
  a first message drafted from their own posts (copied and sent by a person,
  never sent from here), and "Won: make them a client".
- **Leads page:** Influencers / Businesses / Needs a look tabs, best-fit sort,
  "found by" filter, a Why column, the pipeline column, tick several leads to
  add them to a pipeline or mark them at once, and a drawer per lead.
- **Menu:** Pipeline, with a count of your follow-ups due.
- Facebook Page leads are filed as businesses.
