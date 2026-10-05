# Phase 49 — owners live in Edge Meta AI: email code, invite-only, no dashboard

## Run

1. **SQL:** run `sql/schema-phase49.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`), after phase 48. It is idempotent and adds `owner_login_codes`.
2. Deploy the server, then the pages.
3. **Email:** set the Gmail sender in Admin → Trial & plans → Email, using a Gmail address and an app password. Sign-in codes are sent from it.
   - Until then, the app says codes are not switched on.
   - Invites still work without email: you get a one-tap sign-in link to send the owner yourself.
4. **Supabase Auth → URL Configuration:** make sure `https://edgeleadwork.netlify.app/**` is in Redirect URLs. The invite link signs the owner in and lands on `/ai/`.

## What changed

- **Owners have no dashboard any more.**
  - Every owner page (Home, Edge Meta AI inside EdgeLead, Find customers, Local demand) sends an owner login to `/ai/`.
  - Signing in on the EdgeLead login page, choosing a password, or coming back from connecting Meta all land there too.
  - Staff pages are unchanged.
- **Sign-in is a 6-digit code sent by email.**
  - No password.
  - Invite-only: a code goes only to an owner login the agency made. The answer is the same for any other address, and nothing is sent.
  - A code works once, for 10 minutes, and five wrong tries end it. Only a hash of it is kept.
  - Limits: at most one code per 45 seconds, and 6 an hour per address.
  - The app stays signed in after that.
- **Invites** (client → Access → Owner portal, or Admin → Meta & Edge AI → Invite the owner):
  - send a one-tap link that signs the owner straight into the app
  - explain that next time they sign in with a code
- **The Updates row in the app.** Everything the agency shares sits beside the chat:
  - **To-dos:** tick them off. Each has its details and a conversation with the agency.
  - **Posts to approve:** approve, ask for changes, or skip.
  - **Working on:** the agency's open work. Open any of it to see the description with its pictures, the steps, and the conversation; the owner can reply.
  - **Reports:** every report, read in full.
  - **Daily numbers:** the owner's own Meta numbers.
  - **Shared tools:** Find customers and Local demand, if you gave that client access. They open inside the app.
  - The chips with something waiting are gold, with a count.
- **The chat knows the agency's work.**
  - Edge Meta AI has a new tool that reads only what is shared with the owner: their tasks, to-dos, planned posts and reports.
  - It answers "what are you working on?", "what do you need from me?" and "when is the next post?".
  - Approving and ticking off stay as buttons in Updates, never something the AI does from a sentence.
  - Without Meta connected, the chat itself waits for Meta; the Updates row works either way.

## Check after deploy

1. Invite a test owner (a client's Access tab). Open the link on a phone: it lands signed in, in the app. Add it to the home screen.
2. Sign out (⋯ → Sign out). Sign in again: enter the email, receive the code, type it.
3. Share a task with the client ("Client sees it"), with a picture. In the app: Working on → the task shows the picture.
4. Open `edgeleadwork.netlify.app/client.html` as the owner: it goes to the app.
