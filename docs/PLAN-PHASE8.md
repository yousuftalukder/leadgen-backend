# Phase 8 — live-run defects and the IG coverage question

Source of truth for this phase: four screenshots from the 2026-09-06 run, plus a
read of `server.js` (9,568 lines), the five FB pages and the schema files.

## A. What the screenshots actually show

| Screen | Symptom | Root cause (found in code) |
|---|---|---|
| fb-audit | `Could not start: Cannot read properties of undefined (reading 'join')` | Page logs `res.groupNames.join(...)` after queueing. Server never returns `groupNames`. The job **did** start on the server — the page crashed before polling, so every audit looked dead. This is why "auditing rooms never worked." |
| fb-communities Saved rooms | Members = 0 on every row; Median comments = 0 on a room with 60 posts/day | `fbGroupMeta()` only reads member count / rules from the **post** payload of `apify/facebook-groups-scraper`. That actor returns posts, not group metadata, so member_count is always 0 and rules are never seen. Worse: `fbUpsertGroup()` writes `member_count: 0`, `rules_text: null`, `promo_allowed: true` on **every scrape**, wiping anything the user typed in the Edit modal. Discovery already collects `hintMembers`/`hintName` from the search actor but drops them before `fbGroupMeta`. |
| fb-communities Saved rooms | "RI test group" 0 posts/day | Scrape returned zero items (private, or the URL form the actor rejects). Server stores nothing about *why*. Adding `last_scrape_posts` + `last_scrape_note` so the row says what happened. |
| fb-leads | Lead score renders `undefined` | Page reads `s.score`; the column is `lead_score`. |
| fb-leads | A vendor's own advert ("Michael's Home Services LLC… Looking for dependable…") is a **high-urgency lead** | `mineDemand()` matches `looking for` with no check for who is speaking. No vendor / self-promotion filter exists. |
| fb-advisor | "No compliant drafts were produced. This group bans promotion" on a room marked **promo ok** | Route returns that fixed string whenever `drafts.length === 0`. `geminiJSON()` returns `null` on any failure (429, blocked, unparseable), which yields `[]`, which yields the ban message. The real reason is discarded. Also: the gate reads `promoAllowed` from the frozen `report_json`, not from the `fb_groups` row the user can edit. |
| fb-audit | "Posts to sample comments on" (`cposts`) does nothing | Page sends `commentSamplePosts`; server never reads it. And comment text is never analysed anywhere — "sample comments" only raises cost. |

Everything above is deterministic and fixable in code. Nothing here needs a
new Apify run to confirm.

## B. Fix order (this phase)

Deploy order stays SQL → server → pages.

### B1. `schema-phase8.sql`
- `fb_demand_signals.source_type text default 'post'` (`post` | `comment`).
- `fb_groups.last_scrape_posts int`, `fb_groups.last_scrape_note text`.

### B2. `server.js`
1. `/api/fb/audit-community`: return `groupNames`; read `commentSamplePosts` (0–40), put it in `job.input`; fold it into the estimate.
2. `fbEstimateCredits(groups, posts, sampleComments, commentPosts)`: comment surcharge applies to `min(commentPosts, posts)` posts, not all of them. `/api/fb/estimate-credits` reads `cposts`.
3. `fb_community_audit` worker → `fbProcessGroup` → `fbScrapeGroup`: `commentSamplePosts` flows through; `maxComments` is only set when comments are wanted.
4. `fbProcessGroup`: after posts are mined, take the top-N posts by engagement (N = `commentSamplePosts`), run `mineDemand` over their comment texts, tag `source_type: 'comment'`, unique key `${postId}#c${i}`. This is the first time the comment spend produces anything.
5. `fbGroupMeta`: fall back to `groupRef.hintName` / `groupRef.hintMembers`; read a wider set of member-count keys.
6. `fbUpsertGroup(userId, meta, extra, { preserve })`: in preserve mode (every scrape path) omit `member_count` when 0, omit `name` when it is just the id, omit `rules_text/promo_allowed/approval_required` when no rules were scraped, omit `privacy` unless it is positively `private`. Postgres `ON CONFLICT DO UPDATE` only touches supplied columns, so user edits survive. Manual add/edit routes keep full-overwrite semantics.
7. `fbScrapeGroup`: log item count and first-item keys at info level; write `last_scrape_posts` / `last_scrape_note` on the group row so a 0-post room explains itself.
8. `mineDemand`: `looksLikeVendor(text)` — first-person service pitch, phone/WhatsApp number, "our services include", "book now", `LLC|Ltd`, "DM for price", price lists, 5+ service-list emojis. Vendor posts return `[]`. Demand posts are questions asked *by* buyers; this removes the loudest false-positive class.
9. `/api/fb/suggest-posts`: load the `fb_groups` row and let its `promo_allowed` / `rules_text` override the frozen report values. Call `geminiCallDetailed` so the error says *why* (rate limited / blocked / unparseable / empty), with the right status (429 → 503 retry, otherwise 502). The "bans promotion" message only appears when drafts existed and were all removed by the compliance gate.

### B3. Pages
- `fb-leads.html`: `s.lead_score`; show `source_type` badge.
- `fb-audit.html`: estimate query sends `cposts`; drop `saveSet` (server never read it).

## C. Not changed, and why
- FB group **member count and rules** still cannot be scraped from the posts actor. The manual Edit modal is the source of truth for those until a group-details actor is verified against real output (candidates exist in the Apify store; none is wired blind). Room Value already damps on missing members, and the preserve-mode upsert means you type it once.
- Private groups stay unsupported (needs a logged-in session).

## D. Instagram — are we pulling everything a crawler can give?

What the two IG engines use today: `apify/instagram-profile-scraper` (followers, following, posts count, bio, external URL, business flags) and `apify/instagram-scraper` posts (likes, comment **count**, views, caption, hashtags, mentions, tagged users, location, alt text, dimensions, sponsored flag, audio, first comment, carousel size). Lead Finder: location-URL posts, hashtag posts, competitor `/tagged/`, and user search, then profile enrichment.

### D1. Hard ceiling — not obtainable by any scraper
Saves, shares, reach, impressions, profile visits, follower demographics, story metrics. These exist only in the Insights API for the account owner. No actor returns them. Any tool claiming to is estimating. The performance model should keep saying so in the report rather than implying completeness.

### D2. Obtainable and currently skipped — Performance Audit
| Signal | Source | Value |
|---|---|---|
| Comment **text** on the top/bottom ~15 posts | `apify/instagram-comment-scraper` | Sentiment, question density, "how much / where to buy" intent — the IG equivalent of demand mining. Also identifies the people who engage most. |
| Reel plays vs video views | already in `instagram-scraper` output (`videoPlayCount` / `videoViewCount`) | Distinguish autoplay views from plays; today `getViews()` collapses them. |
| Follower snapshot history | our own DB, each run | Growth between audits; nothing external. |
| Posting-gap / cadence drift | our own DB | Already partly there (`cadence`). |

### D3. Obtainable and currently skipped — Lead Finder
| Method | Source | Why it matters |
|---|---|---|
| **Commenters on competitor posts** | `instagram-comment-scraper` over the competitor's last N posts | Warmest possible list: people already talking to a rival, with the comment text as the intent signal. Strictly better than `/tagged/`. |
| **Likers of competitor posts** | likers scraper (several in the store — verify one against output before wiring) | Larger, colder list; useful for volume. |
| **Competitor followers** | followers scraper (same caveat) | The classic list; expensive at scale, cap it. |
| Place search by name | `instagram-search-scraper` with `searchType: 'place'` | Today Method 1 demands a pasted `explore/locations` URL. Search by "Rangpur" → location ids → posts. |
| Bio contact extraction | already returned by profile scraper (public email / phone / WhatsApp link in bio) | Store and surface on the lead card; today it is discarded. |
| Hashtag → top vs recent | `instagram-hashtag-scraper` | Recent posts = active people now; top posts = established accounts. Different lead types. |

### D4. Order I would build D2/D3 (Phase 9, after this phase certifies)
1. Comment scraping for competitor posts (Lead Finder Method 7) — reuses the comment actor for D2 as well.
2. Bio contact extraction on enrichment — zero extra Apify cost.
3. Place search by name — removes the worst UX step in Lead Finder.
4. Comment text on audited posts (Performance Audit).
5. Likers / followers — only after one actor is confirmed against live output; cost-gated.

None of D is wired in this phase. Actor names in D3 rows 2–3 are unverified and must be checked against a real run before any code references them.

---

## E. Delivered in this pass

| File | What changed |
|---|---|
| `schema-phase8.sql` | `fb_demand_signals.source_type`; `fb_groups.last_scrape_posts`, `last_scrape_note`. |
| `server.js` | All of B2 (items 1–9). `APP_VERSION` default → `phase8`. Parses clean. |
| `fb-audit.html` | `cposts` in estimate; `saveSet` removed; `groupNames` guarded. |
| `fb-leads.html` | `lead_score`; post/comment origin shown. |
| `fb-communities.html` | "0 posts last scrape" badge with the reason on hover; members shows `—` with an explanation instead of `0`. |

Deploy: run `schema-phase8.sql` → deploy `server.js` (set `APP_VERSION=phase8`) → upload the three pages → hard refresh.

First thing to re-test: fb-audit on "Keep it Local – RI", 30 posts, 14 days, comments on, cposts 10. The page must now poll instead of dying, `/api/job/<id>` → `input.commentSamplePosts` is 10, and the lead feed should have no vendor ads and possibly some "said in a comment" rows.
