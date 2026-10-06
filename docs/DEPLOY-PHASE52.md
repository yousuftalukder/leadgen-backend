# Phase 52 — the owner app, finished (audit batch 2)

## Run

1. **SQL:** run `sql/schema-phase52.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`), after phase 51. It is idempotent. It:
   - adds `app_users.agency_owner` and marks every owner login already on a business
   - updates `el_account_state` so those logins count as paid
   - adds `xp_ai_conversations.user_id`
2. Deploy the server, then the pages. The service worker moves to `el-shell-v6`, so installed apps pick up the new pages on their next open.

## What changed

- **Owner logins never run out.**
  - A login the agency invites, or adds to a business as an editor, is an agency owner login.
  - It works for as long as the business is one of your clients. There is no trial clock on it.
  - Self-serve signups keep their trial, as before.
  - The Owner portal card no longer asks for "Paid until"; it says the login never runs out.
- **Closing a business ends the owner's access, clearly.**
  - Archive or remove a client and its owner login has no business any more. The app shows "Your access has ended", with Sign out.
  - Before this, the server quietly made an empty "My business" for them.
  - Such a login gets no sign-in code.
  - Work it tries to start is refused with `no_business`.
- **New sign-in link** (client → Access → Owner portal → New sign-in link).
  - Makes a fresh one-tap link for the owner on this business.
  - With Gmail set up, it goes to the owner's inbox. Without it, you get the link to pass on.
  - Use it when their first link expired and codes are not switched on yet.
- **Expired links are explained.**
  - Opening a used or expired invite link lands on the app's sign-in screen with that said plainly, and the code form ready.
  - The old password page says the same, and points owners to the app.
- **Each person keeps their own chats.**
  - The owner and your team each see only their own Edge Meta AI chats about a business. Nobody can open, rename or delete someone else's.
  - Chats from before this phase stay with the team; owners don't see them.
- **The app, tidied.**
  - Refusal screens (access ended, account disabled, server unreachable) no longer draw EdgeLead's staff sidebar inside the app. They scroll, and have Sign out.
  - The chat's own requests handle a lost session or ended account like every other page.
  - A chat's Rename/Delete menu opens above the chats drawer on a phone.
  - "No code? Check spam" is grey, not red.
  - When Meta stops letting us read, a Reconnect strip stays under the header once the chat is going. Before, it only showed on the empty welcome, and phones hide the status line.
  - "Reading your numbers" no longer polls every 15 seconds for ever. It backs off to every 2 minutes. If the first read finished with nothing, it says so instead.
  - Updates sheets have a real Back: a task opened from To-dos goes back to the list. The phone's back button does the same instead of leaving the app.
  - A check-up that pauses says so in the owner's words. The staff "Update key / Resume" banner is never shown to an owner. If they left the sheet, a toast says when it is ready.
  - Staff who sign out from `/ai/` land on EdgeLead's login. Signing out inside a shared tool signs the whole app out.
  - The service worker had a duplicate entry that made its precache fail. It is fixed.

## Check after deploy

1. Client → Access: the Owner portal card has **New sign-in link** beside the owner. Press it and open the link on a phone: it lands signed in.
2. Open an old, used invite link: the app says the link expired and offers the code form.
3. As staff, ask Edge Meta AI something in a client's Ask AI tab. As the owner, the app's chat list doesn't show it.
4. Archive a test client with an owner login, then open the app as that owner: "Your access has ended". Unarchive it again.
