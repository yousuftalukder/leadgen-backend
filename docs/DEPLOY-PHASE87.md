# Phase 87 — the workspace as the ad manager's memory

Ads are checked every three days, by a person or by Claude, and whoever does it starts with no memory. This phase puts everything a check-in needs in the workspace: what a result is worth, what happened to the orders, and what was decided last time and why. The plan is `docs/PLAN-AD-OPS.md`; the method is `.claude/skills/ad-setup/REVIEW.md`. Nothing here writes to Meta.

## Run

Order: SQL → server → pages.

1. In the Supabase SQL editor, run `sql/schema-phase87.sql`. It is safe to run twice. It adds:
   - three columns: `thruplays` and `video_p100` on `xp_ad_daily_snapshots`, and `disable_reason` on `xp_meta_ad_accounts`
   - `components` on `client_products`
   - four tables: `xp_ad_reach_windows`, `client_ad_economics`, `client_orders` and `client_ad_decisions`
2. Merge. Render (the server) and Netlify (the pages) deploy by themselves. Check Netlify actually published the deploy (see phase 86).
3. ThruPlays and 7-day frequency fill in on the next ads sync (09:00 and 21:00 UTC), or straight away from admin → Ads.

**Optional:** set `ORDER_HASH_SECRET` on Render to a long random string (`openssl rand -hex 32`). If it is not set, `APP_ENCRYPTION_KEY` is used instead. Either way, do not change it later: buyers coded with the old secret would no longer be recognised as returning.

**Before the SQL is run:**
- The ads sync stores what it did before, without the new figures.
- The new tabs say which SQL to run.
- A product can't be given combo parts yet.

## What changed

### 87a: the ads sync
- **ThruPlays and plays to the end**, per ad per day. Watch-through = ThruPlays ÷ 3-second plays. Days closed before this phase (over 29 days old) stay without them.
- **Each ad's last 7 days as one window:** reach, impressions and frequency. Frequency can't be added up from daily rows, so it is read from Meta as a window and replaced on every sync.
- **Why Meta disabled an account** (`disable_reason`), for the health panel.

### 87b: what a result is worth
- **Delivery & costs**, per client (Orders tab, Ad ledger → Products, or the check-in):
  - each delivery zone: what the customer pays and what the courier costs
  - COD fee %, failed parcels %, money lost per failed parcel, packing
  - the defaults are 1%, 20%, 120 and 0
- **Combos are made of other products** (Ad ledger → a product → "Made of"). A combo's buying cost and stock come from its parts when its own are left empty. Stock is what the scarcest part allows.
- **Every product shows its break-even and target cost per order:**
  - break-even = margin − COD fee − failed-parcel cost − packing − the most the business tops up any zone's courier cost
  - with free delivery: also less the dearest zone's courier cost
  - target = half of break-even
  - a product without a price or a buying cost says what is missing; nothing is guessed

### 87c: the orders log (new **Orders** tab)
- One row per order:
  - date, how it came in, items and quantities, value (the items' total unless typed)
  - delivery zone, delivery charge, free delivery
  - where it came from (an ad and which one, organic, repeat buyer)
  - status: confirmed → shipped → delivered / failed / returned, or cancelled
- **The phone number is never stored.** It becomes an HMAC code, used only to tell a returning buyer from a new one. The same number typed as 01711…, +8801711… or 8801711… is one buyer. A returning buyer with no source becomes a repeat order.
- **Only the client's editors see order rows.** The check-in and the results report show counts and totals only.
- Orders don't change stock: stock stays what the team types in Products.

### 87d: the decision log, the check-in and the lessons library
- **Ads check-in** tab, and `GET /api/clients/:id/ad-checkin?from=&to=` (default: the last 3 days). Per ad and ad set, for the period, the last 7 days and the life so far:
  - spend, CPM, stop-scroll, watch-through, CTR, cost per message, orders, cost per order, 7-day frequency
  - **the chain of eight steps** from REVIEW.md, each ok, broken, too early or not known, with **the first broken step** flagged and its next move
  - Evidence rules:
    - CPM is judged from 1,000 impressions, stop-scroll from 1,500 impressions, watch-through from 300 plays.
    - Cost per message and cost per order need 2× their target spent first.
    - Chats → orders and cost per order are judged over 7 days.
  - An ad's own on/off isn't read from Meta. An ad that spent nothing in the period counts as paused. "Not delivering" (step 1) is flagged on its ad set instead: a live ad set that spent nothing.
- **Beside the chain:**
  - stock, with days left from the last 14 days of orders
  - spend this month against the brief's budget, and the pace
  - the month against the plan's forecast
  - campaigns that spent but are in no plan or ledger row (the owner's own boosts)
  - account health
  - the whole business day by day: orders from every source, delivered sales, **MER** (delivered sales ÷ ad spend), cost per delivered order, and a note when Meta's purchase count and the logged orders disagree
  - the thresholds used and where each came from
  - what the check-in could not see
- **Thresholds come from the plan.** The plan form has new fields:
  - target cost per order, highest CPM, lowest stop-scroll %, highest 7-day frequency
  - the month's expected spend, messages, chat → order rate and orders
  - the Meta campaign ids the plan became
  - Without them, the defaults are: CPM 1.5× the account's last 30 days, stop-scroll 25%, frequency 3, cost per order half the median product break-even.
- **Decisions:**
  - log each change: date, what it applies to, what changed, the step it answers, the number it should move, expected, when we will know
  - grade it when the date comes: right, wrong or too early, what happened, and the lesson tagged by idea (opening, angle, offer, audience…)
- **The lessons library** (`GET /api/ad-lessons`): graded lessons from every business the person can open, the same kind of business first. Never another agency's.
- **Copy as text** gives the whole check-in as one block for a chat.

### The results report (new page `results.html`)
- From the check-in, **Results report**: a client's month as what we spent, what it sold, and what is next.
- What it shows:
  - spend, conversations and cost per conversation
  - orders, delivered, delivered sales, return on ad spend, ad cost per delivered order
  - new and returning buyers, failed parcels
  - each figure against last month
  - the best ads and products
  - what was changed and whether it worked
  - the plan and the next check date
- Without logged orders, it uses Meta's purchases and says so.
- **Print or save as PDF.** Figures are read live, so a month still running changes.

### Phones
- Wide tables become one card per row below 560px: the content plan, the ad ledger (overview, products, creatives, ads), the ad brief, orders and the check-in. The row's name leads, then one "label … value" line per column.
- Service worker cache `el-shell-v13`.

### Server
- New part `src/24-ad-ops.js`. The runtime part moves to `src/25-runtime.js`; it must stay last.
- A merged client brings its orders, decisions and Delivery & costs along.

## Not covered
- Rejected ads and verification warnings are not read from Meta. The check-in says to look at Account Quality.
- Orders are typed by the team. Nothing reads Messenger orders or a courier's statuses automatically.
- The results report is staff-only: it is printed or saved as a PDF and sent. It is not in the owner's app.

## Check after deploy
1. Run the SQL and merge. In admin → Ads, sync now.
2. Open a client with ads → **Ads check-in**. Each ad shows its chain, and broken steps are listed at the top. The figures match Ads Manager for the same days. Watch-through and frequency show after the first sync.
3. **Orders → Delivery & costs**: add the zones and the courier's failed-parcel rate. Ad ledger → Products now shows a break-even and target for every priced product.
4. Add two orders with the same phone number in different formats. The second shows as Returning, and the number appears nowhere afterwards.
5. On the check-in, **Log a decision** with a check date of today, reload, and grade it. Its lesson shows in the Lessons library.
6. **Results report**: print or save as a PDF.
7. On a phone, open the Ad ledger → Products: one card per product, no sideways scroll.
