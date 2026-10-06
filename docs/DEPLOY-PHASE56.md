# Phase 56 — the Clients hub: trials, stages, owner logins

## Run

1. **SQL:** run `sql/schema-phase56.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It adds:
   - the trial dates on clients
   - `last_seen_at` on logins, filled once from Supabase's own last sign-in
2. Deploy the server, then the pages.

## What changed

**Clients** is now the one place to add, invite and follow every business.

- **New** (top right) has two choices:
  - **Onboard a client:** the 4-step form, as before. The owner's login never runs out.
  - **Start a trial:**
    - Enter the business name, the owner's email and a length (7, 14 or 30 days).
    - The business is created and the owner is invited in one step. They get Edge Meta AI straight away.
- **Stages**, with a count on each. A client is in exactly one:
  - **Trial:** on a trial. The row shows days left, or "Trial ended".
  - **Onboarding:** no owner login yet, or the owner is in but Meta is not connected.
  - **Invited:** the owner has a login but has never signed in.
  - **Active:** the owner uses the app and Meta is connected.
  - **Archived**
- **Each row** shows:
  - the owner, and when they last signed in
  - Meta: connected or not, when Edge Meta AI last read it, and whether the full history is in
  - the **next step** as a button: Invite owner, New sign-in link, Connect Meta, Read full history or Extend trial
- **⋯ on each row:**
  - Open client
  - Read Meta numbers now
  - Read full history again (the Meta backfill)
  - Invite another owner login
  - New sign-in link
  - Extend trial, or make a client (ends the trial)
  - Put on a trial
- **The Owner logins tab** lists every owner login in one place:
  - the business, when they were invited and when they last signed in
  - **Uses the app** or **Not opened yet**
  - **New sign-in link** and **Remove**
- **When a trial ends:**
  - the owner's app says "Your trial has ended", with the date, and nothing else
  - no sign-in code goes out
  - nothing is deleted
- **Extend** adds days to what is left; an ended trial starts again from today. **Make a client** ends the trial for good.
- Your team keeps full access to a trial business the whole time.

## Check after deploy

1. Clients → **New → Start a trial**. Use your own second email as the owner. The link signs you into Edge Meta AI.
2. The row shows **Trial · 14 days left**. The Owner logins tab shows the login, then **Uses the app** once you have opened it. That can take up to an hour, because a sign-in is recorded at most once an hour.
3. ⋯ → **Make a client**: the row moves to Onboarding.
