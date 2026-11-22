# Phase 84 — Edge Meta AI's settings, as in the Owner Assistant

Phases 80–83 did the parts that were named: no zoom, the theme, the profile, Bangla. This phase goes through the Owner Assistant's account menu, Profile and Help item by item, and brings over everything that applies to Edge Meta AI.

## Run

1. In the Supabase SQL editor, run `sql/schema-phase84.sql`. It adds `app_users.ui_language` and `clients.owner_details`, and is safe to run twice.
2. Merge. Render (the server) and Netlify (the pages) deploy by themselves.

Until the SQL is run, saving a language on the account or saving the business details says to run it. Everything else works.

## What changed

- **The account menu is laid out like the Owner Assistant's:**
  - Profile at the top.
  - Then Add to Home Screen and Help.
  - **Theme** is a row with Dark | Light, and **Language** is a row with English | বাংলা. Each row shows the current choice.
  - Sign out is last.
- **The language is kept on the account** (`ui_language`), as in the Owner Assistant, so every device the owner signs in on follows it. After sign-in, the account's choice wins over the device's.
- **Profile, in three cards:**
  - **Your details:**
    - Name.
    - A phone with a country code: Bangladesh first, every country listed.
    - The phone is checked on the page and on the server with the same rules (`frontend/phone-codes.js`, from the Owner Assistant), and kept as "+880 1712345678".
    - A number saved before this phase is read as a Bangladesh number.
  - **Your business:**
    - The business as the agency has it: name, what they do, where, Instagram.
    - What the owner adds: business phone, website, address, opening hours, and anything the agency should know.
    - Only the owner's own business is changed, and never the agency's fields.
  - **Sign-in:**
    - The email, and how signing in works (a code; no password).
    - **Sign out on every device.**
- **The agency sees what the owner filled in** on the client's Settings tab, in a **From the owner** card. It is read only, because it is the owner's.
- **Help is grouped questions that open, as in the Owner Assistant:**
  - Asking questions, including how to ask in Bangla.
  - Chats.
  - Your agency's work.
  - Your account.
  - The app: theme, and Add to Home Screen.
  - Privacy: who sees the chats, and whether an answer can be wrong.
- **Everything new is in Bangla too**, including the phone checks' messages.
- **Service worker:** `el-shell-v10` (adds `phone-codes.js`), with the language files at `?v=2`.

## Left out on purpose

These Owner Assistant features don't apply here:

- **Username, password and its change, Forgot password, Remember me, and the phone's face or fingerprint lock:** Edge Meta AI signs in with a code sent by email, so there is no password.
- **Changing the email:** the agency does that (phase 79).
- **Switching between restaurants:** one Edge Meta AI login is one business.
- **Choosing the PDF report's language:** reports here are made by the agency.

## Check after deploy

1. https://ai.edgelead.online → account menu: Theme and Language rows. Pick Light, then বাংলা.
2. Sign in on another device: it opens in Bangla.
3. Profile:
   - Type a phone that is too short: the reason shows.
   - Save a correct one: it is kept with +880.
   - Fill in the business's hours and save.
4. In the workspace, open the client → Settings: **From the owner** shows those hours.
5. Help: questions open and close, in English and in Bangla.
