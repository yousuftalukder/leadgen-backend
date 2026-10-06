# Phase 57 — the full review: security, data, the owner app, the workspace

Four reviews ran in parallel over the whole product: the agency's journeys, the owner app, the server, and every page at desktop and phone width. This phase fixes what they found.

## Run

No SQL. Deploy the server, then the pages. The service worker moves to `el-shell-v8`.

## Security and data

- **Owners see only shared reports, everywhere.** The old assistant still let an owner read every report on their business, including competitor research and drafts. It now follows the same rule as the app.
- **Owners no longer get the raw report data** from the staff report routes (costs, internal notes, who ran it).
- **Sign-in can't change anyone's role any more.** A failed database read during sign-in used to re-create an existing teammate or admin as a trial customer. A failed count could make a stranger the admin.
- **First sign-in makes one business, not several.** A new account's first sign-in now creates one business; parallel requests used to create duplicates.
- **Merging clients:**
  - It no longer fails halfway for a business the assistant has never read.
  - A self-serve owner who moves with the merge keeps a login that never expires.
- **Deleting a teammate:**
  - Their campaigns now keep their leads.
  - If the login itself can't be deleted, it is reported. Before, the profile was removed anyway and came back as a new trial on the next sign-in.
- **The monthly report now includes Instagram posts.** It asked for a column the posts table doesn't have, so the query failed and every monthly report went out without them.
- **The client timeline shows its Facebook suggestions again**, for the same reason.
- **Connecting Meta files only this client's Facebook Page.**
  - Before, every Page the Facebook login manages was filed under the client, and other clients' Pages (and Edge Meta AI's copy of their numbers) moved too.
  - Now a Page another client already has stays with it.
  - This client gets its own Page: the one it names, or the only new one.
  - Any other Page waits on Clients → "Pages you manage, not filed yet".
- **Deleting or archiving a client stops all its work:**
  - Edge Meta AI's reads stop, and its copy of the numbers is deleted with the client.
  - The daily Meta read and scheduled runs skip it.
  - A schedule restarted by hand stays paused.
  - Unarchiving resumes only what archiving paused.
- **Resuming a run checks first.** Automatic or manual, a run no longer resumes for a switched-off account, a deleted or archived client, or someone who lost access. A run whose report failed to save now fails, instead of finishing as "done" with nothing to show.
- **A finished job is never marked "interrupted" and run twice.**
- **Smaller fixes:**
  - Content-post dates are checked properly.
  - A pipeline lead goes only to a teammate who can open its client.
  - The AI key pool survives a passing database error.
  - "Own keys only" is not lost on one either.

## The owner app (Edge Meta AI)

- **Sign out works again.** It went to `/ai/ai/`, a page that doesn't exist.
- **Trials that end are explained wherever the owner is:**
  - the chat, the Updates and every request say "Your trial has ended", with the date;
  - the screen shows the agency's contact details;
  - an owner whose trial ended can still get a code, so signing in tells them.
- **Sign-in links work on iPhone.**
  - Invites and new sign-in links now point at the app itself (`/ai/#th=…`).
  - An owner can paste one into the installed app ("Have a sign-in link from your agency? Paste it here"). Before, a link signed in only in Safari.
- **Offline:**
  - The sign-in library is served from the site (`vendor/`) and kept offline, not loaded from a CDN.
  - A first open without a connection says so, with Try again.
- **Chat:**
  - Asking too fast says "wait a few seconds". It no longer claims the daily limit is used up.
  - Errors are in plain words.
  - Status checks keep what they knew when one fails.
  - The welcome stops redrawing on every check.
  - Update times show in the owner's own time.
- **Updates:**
  - There is a Back button on every screen size.
  - Focus moves into the panel and back out again.
  - Escape doesn't throw away a half-typed message.
  - Long task titles wrap.
  - Comments can't be sent twice.
  - "Skip this one" asks twice.
  - Pictures stay visible on a long-open tab.
  - A failed load says "Couldn't load your updates · Retry".
  - Check-up progress is in plain words.
- **On a phone:**
  - iPhone no longer zooms into fields.
  - The chats drawer is out of keyboard reach when closed.
  - Menus close with Escape.
- **Owners no longer see the AI model's name or raw sync errors.**
- **New owner invites get Meta numbers and the check-up only.** The shared tools (Find customers, Local demand) run on your Apify credit, so you switch them on per owner in Team & settings → People.
- **The team sees whether the client reads a task's comments.** The comment box on a task shared with the client now says the client reads its comments.

## The workspace

- **Lists that cover every client show every client.** Pipeline, the follow-up badge, Home and Schedules were quietly narrowed to the last client you opened.
- **Schedules has its own picker:** yours, or one client's (everyone's on it).
- **Home:**
  - Paused runs have a **Resume** button.
  - Trials ending in three days or less, or already ended, are flagged.
  - A new teammate with no clients is told an admin adds them.
- **Repeat on a schedule** shows only where it works (not on monthly reports, plans or client reports).
- **Teammates:**
  - Adding a teammate no longer tells people to "sign up first", which made them a business owner.
  - An owner's login is refused there, with the way to invite them.
- **Team & settings:**
  - It only creates team members and admins.
  - Owner logins show as never expiring and are left out of the sign-up funnel.
  - Tools have names, not engine keys.
  - The tab is now "Email & sign-ups", and says owners need Gmail to sign in.
- **Passwords:**
  - "Forgot your password?" on the sign-in page.
  - "Change password" in the sidebar.
- **Clients:**
  - **Unarchive** is in the ⋯ menu.
  - "New sign-in link" is hidden while a trial has ended.
  - On a phone, each row is a card.
- **Content plan:**
  - It says when the client has no owner login to approve posts.
  - The client hint points to the bar above.
- **Wording:**
  - "Portal" is gone. Owners have Edge Meta AI, and the team role is the account lead.
  - Engine refusals name the tool.
  - The sign-in page has the logo and sends owners to Edge Meta AI.
  - Page titles read "X — EdgeLead".
  - Out-of-date notes on the Facebook pages are rewritten.
  - The Instagram audit page has plain labels.

## Visual

- **Fixed:**
  - Step numbers no longer cover the first letters of each step.
  - Links follow the theme instead of the browser's blue.
  - Checkboxes are themed.
  - The competitor page no longer throws an error on load.
- **No client chosen:** Creator posts and Edge Meta AI (staff) show a clear "Choose a client first" instead of working-looking forms.
- **Smaller fixes:**
  - The tab and chip rows fade at the edge, so it's clear they scroll.
  - Stray full stops are gone from the lead tiles.
  - Lead stat tiles fit two to a row on a phone.
  - Long placeholders stay on one line.
  - The share page's empty-state icon is centred.
  - Label spacing on Find customers is fixed.
  - Menus use the green theme.
