# Phase 79 — change an owner's Edge Meta AI email from the workspace

## Run

There's no SQL. Deploy the server (Render does this by itself on merge) and the pages (Netlify, on merge).

## Why

A business owner who wanted to sign in to Edge Meta AI with another address had no way to: inviting the new address made a second login, and the old one stayed.

## What changed

- **Change email** sits beside **New sign-in link** on each owner login under the client's **Access** tab. Anyone who can edit the client can use it, the same people who can make a new link.
- **Checked before anything changes:**
  - It is this business's owner login, not a team login.
  - It is not also the owner login of another live business. That one is an admin's to change, because it would move the other business's owner too.
  - The new address is valid, different, and has no login yet, whether an owner's or someone on the team's.
- **What changes:**
  - The address in Supabase's sign-in, confirmed, and in EdgeLead's account record. If the second write fails, the first is put back.
  - Unused sign-in codes sent to the old address stop working.
- **Who hears about it:**
  - The new address gets a one-tap sign-in link. Without email set up, the link shows on the page to pass on.
  - The old address is told it was changed, and to reply to the agency if that was not asked for.

## Check after deploy

On a client's Access tab, press **Change email** on the owner login, enter the new address and save. The row shows the new address, the new address gets a sign-in link, and the old address gets the notice.
