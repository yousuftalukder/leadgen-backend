# Phase 72 — mentions show names, never emails

## Run

There's no SQL. Deploy the server on Render, and the pages on Netlify (which happens by itself on merge). Either order works: the page also hides addresses on its own while the server is still the old one.

## Why

Typing `@` in a task comment listed each teammate with their email under their name, and someone with no name on their profile showed as their email. A mention should read as the person's name.

## What changed

- **The @ list** shows names only. The server no longer sends addresses with it, and the page searches by name.
- **No profile name:** the part before the @ stands in, made readable. `yousuf.outreach951@…` shows as "Yousuf Outreach". With nothing usable it says "Teammate".
- **The name chip** in the comment uses the same name.
- **Task emails** ("‹name› mentioned you", and the other task emails) name the sender the same way, never by address.
- **Unchanged:** emails still go to each person's address, and comments written before this keep the name they were written with.

## Check after deploy

1. Open a task and type `@` in a comment. The list shows names and no emails.
2. Mention a teammate and send. Their email says "‹your name› mentioned you: …".
3. If a teammate shows as a made-up name like "Yousuf Outreach", they have no full name. It is set at sign-up or when a user is added in Team & settings; for someone already added, fill `full_name` on their row in the Supabase `app_users` table.
