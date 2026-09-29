# Deploy — phase 38

Stage 3 of the report formats: the **monthly report with Meta**, upgraded to the agency deck's shape,
and a **monthly report without Meta**. No SQL. Server, then pages.

## With Meta (`meta_monthly`), what is new

- **Performance summary:** Facebook and Instagram side by side (new followers, reach, views,
  engagement, profile and Page visits, website taps), with a "Both" column only where both platforms
  have the number, and followers now on each (`monthPlatforms`).
- **The longer view:** five months of reach and new followers, per platform, added up from the daily
  numbers already stored (`monthTrends`, `meta_daily`). Months before the connection show as zero;
  fewer than two months with data and the section is left out.
- **Photos on the best posts:** the monthly job now asks Meta for each post's thumbnail and keeps a
  copy of the best posts' photos (phase 36's storage). The expiring address is never saved.
- **Conclusion:** the model now also writes a 2–3 sentence close with next month's focus.

Reports built before this phase keep working: no photos, no conclusion, and the trends and
side-by-side table appear whenever their data exists.

## Without Meta (`public_monthly`, new)

For a client whose Meta is not connected. Built by a job (`public_monthly`, no Apify credit) from what
earlier runs stored for the client: its own Instagram and Facebook Page posts published in the month
(rivals' posts filed under the client are excluded by handle and Page), follower counts from the
audits read before and after the month, the month's Facebook group reports, and our records.

| Section | Says |
|---|---|
| The month in brief | followers, posts published, likes, comments and shares, views per Reel, and one sentence against the month before |
| Month against month | every public measure with the exact change, then the **"not in this report yet"** box: reach, visits, taps, saves and audience need Meta |
| Top-performing content | the best Instagram posts with kept photos, the best Facebook post quoted |
| What you post | each format against the account's typical post, per platform |
| Against local rivals, and local demand | the latest comparison and how many people asked for the business in local groups |
| What we did | tasks finished and shown to the client, reports delivered, leads found |
| Plan for next month | **connect Meta** first, then the open tasks shown to the client |

Staff build it from the client's **Meta** tab (**Build from public numbers**, month picker) or
`POST /api/reports/public-monthly {clientId, month}` (editors, finished months only). It opens in the
client report view and appears in the owner's portal and on share links like every other report. If
no posts from the month are stored, the job says which run to do first.

## Checks

`npm test`: 433 checks, four new (the Meta monthly keeps photos and never the expiring address; the
side-by-side table sums only where both platforms report; five-month trends from stored daily
numbers; the public monthly end to end: route rules, rival posts excluded, follower change, kept
photo, the missing-numbers box, connect Meta first). Both versions driven in Chromium at desktop and
phone width: no page errors, no horizontal overflow.
