# Plan: the workspace as the ad manager's memory (proposed phase 87)

**Status:** built in phase 87 (Oct 30, 2026): see `docs/DEPLOY-PHASE87.md`. Kept as the reasoning behind it.

## Why

Ads are now reviewed every 3 days by Claude, working from the workspace. Claude starts each session
with no memory, so the workspace must hold everything a check-in needs. That means more than what
the ads did: what each result was worth, what happened to the orders, and what was decided last
time and why. The method is in `.claude/skills/ad-setup/REVIEW.md`. This plan is the data behind it.

## What already exists

| Data | Where | Good for |
|---|---|---|
| One row per ad per day: spend, impressions, reach, clicks, link clicks, 3-second plays, messages, leads, purchases, purchase value | `ad_daily_snapshots` (Stage E sync, `xp/ingest/ads.js`) | history, stop-scroll, cost per message, orders per ad once orders are created in Messenger |
| Ad set settings and 90-day splits by age/gender, region, placement | phase 85 | who the ads work for |
| Products: price, buying price, combo price, stock, in order | workbook (phase 69) | economics, stock checks |
| Ad ledger, content plan, ad plans with stop/scale rules, tasks | phases 69, 78, 85 | plans and check-in dates |

## What's missing, and what to add

### 1. Sync: watch-through and frequency
- Add `video_thruplay_watched_actions` to `INSIGHT_FIELDS`, and store `thruplays` per ad per day.
  Watch-through = ThruPlays ÷ 3-second plays.
- **Frequency can't be added up from daily rows,** because reach doesn't sum across days. Add a
  second insights read per ad with `date_preset=last_7d`, fields `reach, impressions, frequency`,
  stored as the latest 7-day window per ad (`ad_reach_windows`).
- Keep `account_status` and `disable_reason` from the account read, for the health panel.

### 2. Product economics
- **Client settings:**
  - delivery charge by zone (e.g. Chittagong 0, Dhaka 70, other 100)
  - what the business pays the courier
  - COD fee %
  - failed-parcel rate % (default 20, from the courier when known)
  - money lost per failed parcel
  - packing cost
- **Combos become real products made of other products** (component ids and quantities), so a
  combo's buying cost and stock come from its parts. Stock = the smallest component stock.
- **Computed per product and combo:**
  - gross margin
  - break-even ad cost per order, with and without free delivery
  - a suggested target (half of break-even)

  The check-in uses these instead of numbers typed by hand.

### 3. Orders log (`client_orders`)
One row per order:
- date and channel
- items (product ids and quantities) and value
- delivery zone and charge, and whether delivery was free
- source: ad (with `ad_id`, from the Messenger referral when known), organic, or repeat buyer
- status: confirmed → shipped → delivered / failed / returned
- whether the buyer is new or returning

**Privacy:** the buyer is identified by a salted hash of the phone number, never the number itself
in reports. Only editors see the order rows.

This is the one thing Meta can't tell us: real delivered orders, failures and repeat buyers. It
also covers sales that never touch an ad.

### 4. Daily business totals
A view per client per day:
- orders, delivered orders and delivered revenue from all sources
- ad spend (from snapshots)
- **MER** (delivered revenue ÷ ad spend)
- **cost per delivered order**
- **chats → orders** (orders from ads ÷ messages started)

The check-in compares these with Meta's own purchase counts. When the two disagree, believe the
totals.

### 5. Decision log and learning library (`client_ad_decisions`)
Each row holds:
- date and scope (campaign, ad set or ad id)
- what changed
- the chain step it answers (1–8 in REVIEW.md)
- the metric it should move, with the expected value
- the check date
- the outcome: right, wrong or too early, filled in at the check-in
- the lesson, tagged by **idea** (opening type, angle, offer type, audience), not by ad

A "lessons" view across clients lets a new client's plan start from what worked elsewhere.

### 6. The check-in endpoint and page
`GET /api/clients/:id/ad-checkin?from=&to=` returns, per ad and ad set, for the period and for its
life so far:
- spend, CPM, stop-scroll rate, watch-through, CTR, cost per message, orders, cost per order
- 7-day frequency
- the plan's thresholds next to each figure
- **the first broken step**, flagged
- stock left for the products each ad sells
- spend this month against the budget
- campaigns in Meta that no plan or ledger row mentions (e.g. the owner's own boosts)
- account health
- decisions due for grading

The **Ads check-in** tab shows the same as one screen. Claude reads the JSON at each check-in, and
the team reads the page.

### 7. Forecast
The plan stores the month's expected messages, chat → order rate, orders and spend. The check-in
shows actual against expected, so a miss shows up early and in money.

## Build order

Each step ships on its own, in the usual order: SQL → server → pages.

1. **87a:** sync additions (ThruPlays, 7-day reach and frequency, account status). Small, and makes
   the check-in numbers complete.
2. **87b:** economics settings, combos with components, break-even per product.
3. **87c:** the orders log and daily totals, plus a quick "add order" form for the team.
4. **87d:** the decision log, the check-in endpoint and the page.

## Built (phase 87)
- 87a–87d and the forecast are all in. The check-in is `GET /api/clients/:id/ad-checkin` and the
  client's **Ads check-in** tab; orders are the **Orders** tab; the settings are **Delivery & costs**.
- Daily business totals are computed by the server for the check-in rather than kept as a view.
- Orders do not change stock: stock stays what the team types in Products.
