# Phase 82 — Edge Meta AI: the owner's profile (name, phone, photo)

## Run, in this order

1. **SQL:** in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`), run `sql/schema-phase82.sql`. It adds `app_users.phone` and `app_users.avatar_path`, and is safe to run twice.
2. **Server and pages:** merge. Render and Netlify deploy by themselves.

Without step 1, everything works as before except saving the profile: it says which SQL file to run.

The server creates the private `avatars` storage bucket on the first photo upload. Nothing to set up.

## What changed

- **Profile** in Edge Meta AI's account menu, as in the Owner Assistant:
  - **Photo:** a picture from the phone or computer, cropped to a square and made small (320 px JPEG) before it is sent. It can be removed.
  - **Name:** required, 80 letters at most. The team sees this name too, in comments and lists.
  - **Phone:** optional; digits with + ( ) - or spaces.
  - **Email:** shown, not changeable. It is how they sign in, so their agency changes it from the workspace (phase 79).
- The account button at the bottom of the bar shows the photo, or the initials. A change shows at once.
- **Server** (`src/07-system-and-admin.js`):
  - `POST /api/me/profile` saves the name and phone.
  - `POST /api/me/avatar` takes the picture itself as the body. It is checked by its bytes (PNG, JPEG or WebP, 2 MB at most) and replaces the old photo in storage.
  - `DELETE /api/me/avatar` removes it.
  - `/api/me` now returns `full_name`, `phone` and `avatar_url`, a link that lasts a day.
  - Each person changes only their own profile.
- Phone fields now get the same style as the other fields (`app.css`).
- Tests: `tests/phase82.routes.test.js`.

## Check after deploy

1. https://ai.edgelead.online → account menu → **Profile**.
2. Change the name and add a phone, then Save. The bar shows the new name.
3. Change the photo: it shows in the sheet and on the account button. Reload: it is still there.
4. Remove the photo: the initials come back.
