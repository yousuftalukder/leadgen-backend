# Phase 47 — Edge Meta AI runs itself, and works as its own app

## Run

**No SQL.** Deploy the server, then the pages.

Pages: `ai/` (new folder), `meta-ai.js`, `meta-ai.css`, `client-assistant.html`, `client.html`, `admin.html`, `workspace.html`, `header.js`, `sw.js`, `netlify.toml`, `icons/ai-*.png`.

## What changed

### The owner connects Meta, then asks. Nothing else.

- **The first read starts on connect.** Before, it waited for the next 09:00 or 21:00 UTC pass. The read covers the last 90 days and every post, then the ads pass. It starts in any of these ways:
  - the owner or staff connects Meta
  - a Page is filed under a client
  - a client is onboarded from a Page
  - someone opens the chat
  - after a server restart, any business that was never read is started, one at a time
- **Retry limit.** A read that fails is not retried more often than every 30 minutes. The twice-daily pass still runs as before.
- **Home page numbers** are read at the same moment, instead of waiting for the hourly pass.
- **No sync buttons for owners.**
  - **Edge Meta AI**: removed "Read my numbers now". While the first read runs, the chat says what it is reading, checks back by itself, and opens when the data is in. The question box stays closed until then.
  - **Home**: removed "Sync now". The daily numbers card shows "Updates by itself".
- **Reconnect.** If Meta refuses the login, the owner sees a "Reconnect with Facebook" button. Answers keep using the numbers read before.
- **Owners' reads.** An owner can only start a normal read. Re-reading the whole history, or chosen days, is staff only.

### Edge Meta AI as its own app

The chat now also lives at `/ai/` (for example `https://edge-leadgen.netlify.app/ai/`).

- **Its own manifest and icon:** the gold mark with an "AI" badge.
- **Installs separately.** Its scope is `ai/`, so a phone installs it as a second app next to EdgeLead.
- **Opens straight into the chat.** There is no EdgeLead menu.
- **Sign-in.**
  - It signs in on its own screen, so the installed app is never left.
  - It has a "Forgot your password?" link.
  - Signing out returns to that screen.
- **Install prompt.** It offers "Put Edge Meta AI on your home screen". This is remembered separately from EdgeLead's prompt.
- **Chats on a phone** open as a drawer. A ⋯ menu holds **Open EdgeLead** and **Sign out**.
- **Connecting Meta from the app.** Meta always returns to EdgeLead's Home. The Home page sends the owner back to the app automatically.
- **Staff** who open `/ai/` are told it is the owner's app and pointed to Clients.
- **In EdgeLead,** owners see **Open as an app** on the Edge Meta AI page.
- **One shared chat.** The chat code is now in `meta-ai.js` and `meta-ai.css`, used by both `client-assistant.html` and `ai/`.
- **Offline.** The service worker (`el-shell-v4`) keeps the app working offline too.

### Staff: the Meta console

- **Admin → Meta & Edge AI** (new tab) lists every business with Meta, worst first. Each row shows:
  - Page and Instagram
  - when Meta access ends
  - whether the history is read
  - last read
  - days missing in the last 30
  - the owner's login
  - chats in the last 30 days
  - what is wrong, in words
- **Actions on each row:**
  - **Read now**
  - **History and days**: re-read the 90 days, or read a date range of up to 93 days
  - **Reconnect Meta**: opens the client's Meta tab
  - **Invite the owner**: the same invite as the Access tab, with the app link included
  - **Ask as them**
- **Top of the tab:**
  - **Read everyone now**
  - counts: businesses with Meta, all good, need you, reading now, owners with a login
  - the read schedule
  - filters: All, Needs you, No owner login
- **Client → Meta tab** gains an **Edge Meta AI data** card. It shows:
  - each account's history and last read, and how many days and posts are held
  - the last reads, with their errors
  - buttons: **Read now**, **Re-read the history**, **Read these days**

  The connection's **Read numbers now** button now also updates Edge Meta AI.
- **Where owner logins are:** still per client, under **Access → Owner portal**. They can now also be sent from the admin Meta tab.

### Server

- New route `GET /api/xp/admin/overview` (admin only).
- `GET /api/xp/status` now returns `phase`: `not_connected`, `reading`, `ready` or `reconnect`. It starts the first read when one is due.
- `POST /api/xp/sync`:
  - `fullBackfill` and `rangeStart`/`rangeEnd` work for staff only; owners get a normal read.
  - Ranges are checked: real days, oldest first, not in the future, at most 93 days.
- New in `xp/index.js`: `kickoff()`, `catchUp()` and `phaseOf()`.

## Check after deploy

1. **Admin → Meta & Edge AI.** Every business with Meta is listed. Anything red has its reason written next to it.
2. **Connect Meta on a test client.** Within a minute its row shows "Reading the history now". A few minutes later it turns green.
3. **Open `/ai/` on a phone as an owner.**
   - Sign in and ask a question.
   - Then add it to the home screen: Android shows the prompt, and iPhone uses Share → Add to Home Screen.
   - Open it from the home screen. It opens straight into the chat, full screen.
