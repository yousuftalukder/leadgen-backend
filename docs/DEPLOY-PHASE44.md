# Phase 44 — key pools: own keys first, own keys only, one view

## Run

No SQL. Deploy the server, then the pages (`admin.html`).

## What changed

- **"Own keys only" now covers AI as well as Apify.** A staff member set to own keys only (People tab) never uses the shared Gemini pool or the server key. If they have no working key, the AI step is skipped and the reason is shown: "uses its own AI key only … add one with the AI key button".
- **Edge Meta AI uses the key pool.** Keys are tried in the same order as the rest of the app: the person's own key, then the shared pool, then the server key. If a key is rate-limited or refused before any text has streamed, the answer continues on the next key, and that key rests for 90 s or is marked invalid.
- **Admin → Keys (Apify & AI) → "Key pools at a glance":**
  - Every tier in the order it is tried, with active, cooldown, out-of-credit and invalid counts.
  - The company primary key for each engine.
  - Whether a server key is set.
  - A per-person table showing each person's rule, their own keys, and which tier their next scraping run and next AI call would use.
  - No key values are ever sent to the page.
- Resetting a Gemini key makes it usable immediately. Before, it stayed resting locally for up to 90 s.
- The older Instagram and Facebook write-ups already used the person's own key first, because the server knows whose request or job it is. There is now a test for this.
- Test harness: middleware now wraps the route the same way it does in Express.
