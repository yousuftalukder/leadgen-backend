# Deploy — phase 26

The money moment, and the client's Facebook and Meta reports in their own language.

The business model is try free, then buy, with an admin activating by hand. Until this phase the
moment a trial ended looked like: *"Your access has ended. Contact us to continue."* — with
`SUPPORT_EMAIL` blank there was nobody to contact, no way for the client to say they wanted to
continue, and no way for the admin to see who did. The path dead-ended exactly where it should
convert.

## Deploy order

1. **SQL** — `sql/schema-phase26.sql`. Applied live as `phase26_activation_requests`. Two columns
   on `app_users`: `activation_requested_at`, `activation_note`.
2. **Server** — `server.js`.
3. **Pages** — `frontend/` (`header.js`, `admin.html`, `app.css`).

## What changed

| Area | Now |
|---|---|
| `POST /api/me/request-activation` | A client — trial **or lapsed** — records "I want to keep going", with an optional note. The one route a lapsed account may still call: `auth()` grew `allowLapsed`, which lets an *expired* account through and still refuses a suspended one. |
| Trial banner | A **"Keep going after the trial"** action; quiet until the last two days, when it goes gold with the banner. Once sent it reads "Request sent ✓" and stays sent. |
| Expired screen | An **"Ask to continue"** button. If they already asked, it says when, instead of offering the button again (`accountDenial` now carries `activation_requested_at`). |
| Admin → People | A **"wants to continue"** chip on the client, their note beside the activation control, those clients **sorted first**, and "N waiting" on the bucket head. |
| Sidebar | Admins see a **count badge on Admin** — `/api/me` carries `pendingActivations` — so a request is seen without opening the admin page. |
| Activation | Setting `paid_until` clears the request, and **evicts that user's auth-cache entry**: before, a client activated just now kept seeing "your access has ended" for up to a minute, with a Reload button that changed nothing. |
| `/api/client/reports` | Titles were keyed by *job* type for two entries (`fb_page_report`, `fb_community_audit`) that no row ever carried, so a client's Facebook report showed as "Report". Fixed, and the audit now checks the map against every stored `report_type` both ways. |
| `clientReportView` | Facebook Page reports and the two owner-side Meta reports now open in owner language — headline, what is working, what to change, summary, and (monthly) the movements — instead of falling through the Instagram path to an empty page. They carry **no invented peer standing**. |

## Post-deploy checks

1. As a trial client: the banner shows the action; press it; it reads "Request sent ✓". As admin:
   the Admin nav entry shows **1**, People lists that client first with the chip and the note.
2. Set a `paid_until` date on them. Their next request is in (200, state `paid`), the chip is gone,
   the badge is gone.
3. Expire a test client (`trial_ends_at` in the past). Signing in shows the expired screen with
   **Ask to continue**; press it; the screen confirms; reloading shows "You asked to continue on …".
4. As a client with a Facebook page report on file: My Reports names it "Facebook page check-up"
   and opening it shows a headline and points, not an empty page.
5. `npm test` — 326 checks across 11 files; `npm run audit` — 38.

## Known limits

- **No notification leaves the product.** The admin sees the badge and the chip on their next
  visit; nothing emails or messages them. There is no outbound mail in the stack.
- **Money is still collected out of band**, by decision.
- **Older Facebook page reports without `ai_json`** (narrative unavailable when they ran) open
  with the fallback headline and empty points — there is nothing to translate.
