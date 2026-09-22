# Deploy — phase 24

The client sees what was found for them; Meta can ask us to forget someone; the pages App Review
asks for exist.

## Deploy order

1. **SQL** — `sql/schema-phase24.sql`. Applied live as `phase24_meta_data_deletion`. Adds
   `meta_connections.fb_user_id` and the `meta_deletion_requests` table.
2. **Server** — `server.js`. No new environment variables; `META_APP_SECRET` (already set) now also
   verifies deletion requests.
3. **Pages** — `frontend/`. Three new public pages: `privacy.html`, `terms.html`,
   `data-deletion.html`.

## Meta App Dashboard — set these once the pages are live

| Field | Value |
|---|---|
| Privacy Policy URL | `https://edge-leadgen.netlify.app/privacy.html` |
| Terms of Service URL | `https://edge-leadgen.netlify.app/terms.html` |
| User Data Deletion → Data deletion callback URL | `https://leadgen-backend-1-mgzc.onrender.com/api/meta/data-deletion` |
| *or* Data deletion instructions URL | `https://edge-leadgen.netlify.app/data-deletion.html` |

Both deletion options are implemented; the callback is the stronger one because it runs without a
person doing anything. Meta lets you set one; set the callback and the instructions page is linked
from the privacy page regardless.

**Before submitting:** the three pages carry a comment at the top saying so — set `CONTACT_EMAIL`,
and have the operator's name and jurisdiction checked. They are written to be true of what the code
does; they are not legal advice.

## What changed

| Area | Now |
|---|---|
| `meta_connections.fb_user_id` | Captured from `debug_token` at OAuth. A deletion request names the person by this id and nothing else; without it the request could match no row. |
| `POST /api/meta/data-deletion` | Verifies Meta's `signed_request` (HMAC-SHA256 with the app secret, constant-time compare), deletes every connection for that user (media and snapshots cascade) and every owner-side report built from them, records a confirmation, responds in the shape Meta requires. Scraped reports are untouched — they name no Facebook user. |
| `GET /api/public/meta/deletion/:code` | Status for the confirmation page. Public, rate-limited, 404 for anything it does not know. |
| `GET /api/client/leads` | A client account now sees leads its agency found **for** it (via `client_leads` on its business record) alongside its own draws, de-duplicated, each marked `foundForYou`. The page shows "N found for you by your team". |
| Wiring audit | Shell-less public pages are a named set; they skip the header/session checks and keep the parse and reachability checks. |

## Post-deploy checks

1. **Connect Meta as a tester.** `select fb_user_id from meta_connections order by created_at desc limit 1` is populated.
2. **Remove EdgeLead from that Facebook account's Apps & Websites.** Within a minute the connection row
   is gone, `meta_deletion_requests` has a row, and Facebook shows a confirmation code that resolves
   on `data-deletion.html?code=…`.
3. **The client surface.** Sign in as a client the agency took on; Find Leads must list the agency's
   finds with the *team* badge and the count line.
4. `npm test` — 292 checks; `npm run audit` — 36.

## Known limits

- **Deletion is by Facebook user id, so connections made before this phase have no id** and cannot
  be matched by a callback. They can still be removed from the Clients page or by request.
- **Meta's sandbox does not send real deletion callbacks**; the flow is proven by the use-case test
  forging a correctly signed request, and by check 2 above once the app is live.
