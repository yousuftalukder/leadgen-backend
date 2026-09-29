# Phase 41: the review tracker

## What to run

No SQL (it needs phase 40's, which saves reviewers as leads). Merge; Render redeploys.

Environment (optional):
- `REVIEW_MAPS_ACTOR` — the Google Maps actor, default `compass/crawler-google-places`.
- `REVIEW_MAPS_CONTACTS` — `true` (default) asks the actor for each listing's
  social links, which finds more Instagram accounts but costs more per place.
- `COST_PER_1K_PLACES` — the estimate per 1,000 places (default 7 with contacts, 4 without).

**First live run:** check the Maps actor's output field names against what
`reviewPlace()` reads (title, categoryName, website, instagrams, placeId). They
are read defensively, but only a real run proves them.

## What changed

- `reviews.html` (New work → Find customers → Review tracker): a kind of
  business and an area, optionally the client's own handle, or a list of
  Instagram accounts to read directly. The most it can cost is shown first.
- Job `review_scan` (leadgen engine, Apify key):
  1. Google Maps finds the businesses;
  2. each one's Instagram: linked on Maps or on its website ("sure"), else an
     Instagram search checked against the name ("likely"), else listed for a
     person to confirm. Website fetches refuse private and internal addresses,
     on every redirect;
  3. tagged posts per business over the window (90 days by default);
  4. every post sorted: review, paid or hosted review, customer photo, another
     business, unclear. Rules do the clear ones, in English and Bangla; the
     unclear go to Gemini twenty at a time;
  5. reviewers are saved as leads (method "review tracker"), filed under the
     client, and a `review_scan` report is saved.
- The report (`report.html`, owner portal, share links): who is being reviewed
  and by how many creators, the client's share, creators who reviewed rivals
  but not the client, the most-seen reviews, and businesses that could not be
  matched. Scheduled monthly ("Repeat on a schedule"), it marks reviews and
  creators that are new since the previous scan of the same place.

## Update: set up fresh each run

The page is now two steps, and every run chooses its own sources:

1. **Where the businesses come from:** a Google Maps area (one or several kinds
   of business, how many, a minimum Google rating and review count, and whether
   to search Instagram by name for listings with no link), your own list of
   rival handles (the old manual way), or both, plus the client. "Find the
   businesses" (`POST /api/reviews/find`, job `review_places`) finds and
   matches them and reads nothing yet.
2. **Check the list:** untick any, fix or fill in a handle, add more. Then the
   window, tagged posts per business (10–100), and whether AI reads the unclear
   posts. "Read the reviews" scans exactly the ticked list; Maps is not asked
   again.

With only your own list, step one costs nothing and goes straight to the list.
The last setup is remembered in the browser.
