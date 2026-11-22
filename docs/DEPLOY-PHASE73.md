# Phase 73 — owners at ai.edgelead.online; Edge Meta AI sees the Meta the agency connected

## Run

There's no SQL.

1. On Render, set **`OWNER_APP_URL`** = `https://ai.edgelead.online`.
2. Deploy the server (Render does this by itself on merge) and the pages (Netlify, on merge).

Without `OWNER_APP_URL`, owner links stay on the workspace's `/ai/` page as before.

## Why

- **Edge Meta AI said "Meta not connected"** for businesses whose Meta the agency had connected in the workspace. The step that copies a connection into the assistant's tables upserted on `xp_meta_connections.el_connection_id`. That column has only a partial unique index (`where el_connection_id is not null`). Postgres refuses that as an `ON CONFLICT` target, so the step failed for every business ("there is no unique or exclusion constraint matching the ON CONFLICT specification"). The assistant then had no assets, and owners saw nothing about their business.
- **Owners were sent to `workspace.edgelead.online/ai/`** in invite emails, sign-in links, plan emails and after connecting Facebook, though they have their own address.

## What changed

- **The Meta copy:** the connection row is looked up by `el_connection_id`, then updated or inserted. After the deploy the server copies every connected business by itself on its first status check or the boot catch-up, and its first read starts.
- **Owner address, server:** `ownerAppUrl()` (`OWNER_APP_URL`, else the workspace's `/ai/`) is used for:
  - the invite's one-tap link and its "next time, open …" line;
  - the "send a new sign-in link" route;
  - the "your plan is active" email;
  - where Facebook sends an owner back after connecting.
- **Owner address, pages:** `EL.ownerAppHref()` gives `https://ai.edgelead.online/` on EdgeLead's domains, else `ai/`. It is used where an owner is sent to the app:
  - sign-in and welcome;
  - any dashboard page an owner opens;
  - signing out of the app;
  - the link an admin copies from the invite dialog.
- **The workspace's `/ai/`** sends a sign-in link, or anyone not signed in, on to ai.edgelead.online with the link intact. Older emails therefore still work. Someone on the team who is signed in stays where they are.

## Check after deploy

1. Open https://ai.edgelead.online as a business owner whose Meta is connected. Within a few minutes the top right shows "Getting ready…" or "Updated …", not "Meta not connected".
2. Invite an owner from a client. The email's links start with `https://ai.edgelead.online/`.
3. Open an old `https://workspace.edgelead.online/ai/#th=…` link. It lands on ai.edgelead.online and signs in.
