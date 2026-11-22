# Running a client's ads: the check-in and the economics

Read this with `SKILL.md` whenever the user says "check the ads", at every check-in task labelled
**Ads**, and before changing anything that is live. `SKILL.md` covers planning; this file covers
running the account afterwards: knowing what a result is worth, finding what is broken, and deciding
the next step without overreacting.

Written Oct 29, 2026 from research and from Arminabd's own account. Re-check anything Meta may have
changed. Agency and vendor benchmarks below are directional; the client's own numbers win.

## 1. Know what a result is worth before judging it

A cost per message means nothing until you know what an order may cost. Work it out per product or
combo, from the client's **Products** tab, and write it into the plan's rules.

```
gross margin        = customer price − buying price
break-even per order = gross margin − COD fee (≈1% of price) − failed-parcel cost − packing
failed-parcel cost   = (fail rate ÷ (1 − fail rate)) × money lost per failed parcel
with free delivery   = break-even − the delivery charge the business now pays
target cost per order ≈ half of break-even (the rest is profit and room for error)
target cost per message = target cost per order × share of chats that become orders
```

- **Cash-on-delivery failure is real money in Bangladesh.** Pathao says most merchants deliver
  75–85% of parcels. Use 20% failed until the client gives their courier's figure, and about ৳120
  lost per failed parcel (delivery plus return charge). Ask for the real rate.
- **Free delivery can wipe out a cheap item's margin.** Check every free-delivery offer against
  break-even. Limit it to combos, bundles or a minimum basket when singles go negative.
- **Push the products that can afford ads.** A high-margin product can pay several times more per
  order than a low-margin one. Put the testing money behind it, even if the current winner sells
  something cheaper.
- If a buying price is missing, say so and keep discounts small. Never invent a cost.

## 2. Measure orders, not just chats

Meta counts messages. The business lives on delivered orders.

- **Create every confirmed order in Messenger.** In the Meta Business Suite inbox, open the chat,
  click **Create order**, add the items and price, and mark it paid when cash comes in. This sends
  purchase events, so Ads Manager and the workspace sync (purchases, purchase value, ROAS) show
  orders per ad.
- **After 5+ purchase events in 30 days**, Meta offers **Sales → "Maximize number of purchases
  through messaging"** for Messenger ads. Meta reports about 11% more purchases than conversation
  optimisation (Meta's own figure). Test it against the conversations campaign; don't switch blind.
- **Also track the whole business every day:** total orders and revenue from all sources, against
  total ad spend. Meta takes credit for some sales that would have happened anyway. If Meta's
  numbers improve but total orders don't, believe the totals.
- **Log every order's outcome** (delivered, failed, returned) and whether the buyer is new or
  returning. Until the system holds this, ask the team for counts at each check-in.

## 3. The check-in: every 3 days, the same chain

Pull these per ad for the period since the last check, and for the ad's life so far:

| Column in Ads Manager | Use |
|---|---|
| Amount spent, Impressions, Reach, Frequency | delivery and fatigue |
| CPM | cost of reaching people |
| 3-second video plays | stop-scroll rate = plays ÷ impressions |
| 15-second ThruPlays | watch-through = ThruPlays ÷ 3-second plays |
| CTR (all) | interest |
| Results, Cost per result | messages and cost per message |
| Purchases, Purchase value | orders per ad (once orders are created in Messenger) |

The pane is narrow, so give the tab a 1440×900 viewport. Ads Manager only renders the columns that
fit, so ask for a few columns at a time in the URL: `…/manage/ads?act=<id>&columns=name%2Cimpressions%2Cactions%3Avideo_view%2Cvideo_thruplay_watched_actions%3Avideo_view%2Cctr%2Cresults%2Ccost_per_result&insights_date=<from>_<to>%2Ccustom`.

Then walk the chain. **Stop at the first broken step.** Everything after it is a symptom.

| Step | Healthy | If broken, the cause is usually | Next move |
|---|---|---|---|
| 1. Delivering | spending its budget | rejected ad, tiny audience, payment, account limits | fix the setting |
| 2. Cost to reach (CPM) | near the account's normal | narrow audience, poor ad quality, competition (sale days) | broaden, or new creative |
| 3. Stop-scroll | 25%+ (account's winner) | weak first 2 seconds | new opening, same video |
| 4. Watch-through | near the winner's | slow middle, too long | shorter cut |
| 5. Cost per message | under target | weak call to action, promise unclear | clearer offer and button |
| 6. Chats → orders | at or above target | **the inbox**: slow reply, price shock, delivery fee, trust, ad and auto-reply disagree | read 10 chats, fix the script |
| 7. Cost per order | under target, below break-even | margin too low for the ads | bundles, higher-margin products |
| 8. Fatigue | frequency under ~3 a week | same people seeing it | new version |

Also check at every check-in:

- **Stock** of every advertised product. Pause before it runs out, not after.
- **Spend against the month's budget.**
- **Anything new in the account** that the team didn't log, such as the owner's own boosts. Measure
  it separately.
- **Account health:** verification warnings, rejected ads, payment problems.

## 4. Rules that stop overreacting

- **Judge at the right speed.**
  - Stop-scroll, cost per message and CPM can be read at day 3.
  - Orders are judged weekly. At ৳125 a day a few orders is noise.
- **Minimum evidence before killing an ad:** about 2–3× its target cost per message spent, or
  1,500 impressions for a stop-scroll judgement.
- **Budget changes ≤20% at a time**, on ad sets that are out of learning. Changes to audience,
  optimisation or creative restart Meta's learning (about 50 results a week to leave it). A small
  budget will often show "learning limited". That's acceptable; don't churn to escape it.
- **One change per ad set per check-in,** so the next check shows what caused what.
- **Fixed-shape rules,** written into the plan with numbers: stop (cost per message, stop-scroll
  floor), promote to the main campaign, scale (cost per order under half of break-even for 7 days
  and stock 10+), and refresh (frequency over 3 with cost up 30% on its first week).

## 5. The decision log and the learning library

Every change gets a line in the plan's review note, or the Ad ledger's "What we learned":

> date · what changed · why (which step of the chain) · the number it should move · when we'll know

At the next check-in, grade it: right, wrong, or too early. Write the lesson about the **idea**, not
the ad, so it carries to other products and clients. For example: "problem-first openings beat
price-first for balms", or "her face + price in the first second beats product close-ups".

## 6. Creative is the targeting now

Meta's delivery leans on the ads themselves to find buyers. Experts keep a pipeline, not one-off
posts:

- 2–3 new versions a week in the testing ad set.
- Each video cut 3 ways: problem-first, price or offer-first, and the person's own words.
- Different ideas, not small edits of the same ad.
- The best version moves to the main campaign. Losers stop at the rule's threshold.
- Plan filming so a new ad is ready before the current winner tires (often 2–4 weeks).

## 7. After the sale: repeat buyers

A buyer who reorders costs no ad money. Save every buyer (WhatsApp Business app or the inbox
labels), and send a reorder reminder when the product would run out, with a small returning-buyer
offer. Count repeat orders separately.

## 8. Reporting to the user

At each check-in say, in this order:

1. The first broken step and the evidence.
2. What you changed or propose, and the number it should move.
3. What you couldn't see (missing orders, stock, costs).
4. The next check date.

Never call a result good or bad without the number and the comparison it was judged against.
