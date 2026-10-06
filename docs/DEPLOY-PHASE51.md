# Phase 51 — audit batch 1: security and data loss

## Run

1. **SQL first:** run `sql/schema-phase51.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It is idempotent.
2. Then the server, then the pages (`header.js`, `workspace.html`, `admin.html`).
3. **Check:** Supabase → Advisors → Security should show no "RLS disabled in public" and no "Security definer view".

## What changed

1. **Deleting a staff member no longer deletes their clients.**
   - Before, every client they created was deleted with them, along with all its tasks, posts, schedules and owner logins. So were their Meta connections, schedules, jobs and scraped posts, on any client.
   - Now all of it moves to the admin who deletes them, before the login is removed: clients, schedules, Meta connections, share links, jobs, posts, competitor sets, campaigns, content notes, AI chats, reports, all Facebook data, and their assigned tasks.
   - If something the admin already holds would be duplicated (the same Page connected twice, say), the admin's copy is kept.
   - If the hand-over fails, nothing is deleted.
   - What goes: their personal keys, usage counters and the login itself.
2. **Reports reach the owner only when you share them.**
   - Every report page has a new **Share with the owner** button, next to Share link. The client's Reports list marks shared ones **Owner sees it**.
   - Owners still always see check-ups they ran themselves.
   - Existing reports start hidden: share the ones the owner should have.
   - The owner's report list, opening a report by id, and Edge Meta AI all follow this.
3. **Owner logins are kept out of every agency route.** An invite makes the owner a member of the client record, and through that they could:
   - read your team's emails, job errors and costs, and internal notes
   - rename or archive the client
   - run, pause or delete schedules
   - revoke share links
   - add team members

   Now owner logins get only their own routes (the app). An owner's work is always filed under their own business, whatever client id the browser sends.
4. **The database is closed to the public key.**
   - The anon key is in every page. Some tables had no row security and some views ran as their owner, so that key could read, and in places change, data directly.
   - Row security is now on for every table, views run as the caller, and the public roles have no rights on tables, views or functions. The same applies to anything created later.
   - The server uses the service role and is unaffected. The site only uses Supabase to sign in.
5. **Sign-in codes:**
   - Each guess is counted before it is checked, in one database step, so guesses sent at the same moment can no longer get past five tries.
   - A code is marked used by exactly one request.
   - The hourly limit gives the same answer as any other address, so it no longer tells anyone which emails have logins.

## Check after deploy

1. Admin → People: deleting a test staff member moves their test client to you. It shows in Clients with its tasks and schedules.
2. Open a report → **Share with the owner**. The owner's app shows it under Reports. Click again: it's gone.
3. As a test owner, opening `workspace.html` still sends you to the app.
