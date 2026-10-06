# Phase 53 — the agency's workflow (audit batch 3)

## Run

No SQL. Deploy the server, then the pages.

## What changed

- **An approved post's task goes to someone.**
  - When the owner approves a planned post, the "Make the reel: …" task now goes to whoever made the plan (or the pick).
  - If that person is no longer on the client, it goes to the client's account lead. Before, it went to nobody.
- **The board and the calendar stay in step.**
  - Moving that task to Done marks the post **Made**. Reopening the task puts the post back to **Approved**.
  - A post that's already posted, or one the owner sent back for changes, is left alone.
- **Two people editing one task.**
  - If someone saved a task while you had it open, your save is no longer written over theirs. You're told, your edits stay in the form, and you choose: **Save mine over theirs** or **Show theirs instead**.
  - Dragging cards on the board is unaffected.
- **Archiving a client stops what it was running.**
  - Its scheduled reports pause, and Edge Meta AI stops reading its Meta twice a day.
  - Unarchiving resumes exactly the schedules archiving paused, never one your team paused itself.
  - The owner's app already shows "Your access has ended" for an archived client (phase 52).
- **Merging two clients carries everything.**
  - The content calendar, picks, topics, the lead pipeline and Edge Meta AI chats now move too. Before, they stayed on the archived record.
  - A topic or pipeline lead both records already had stays on the archived one.
  - If the merged record had Meta connected, Edge Meta AI drops the old copy of the numbers and reads the history again for the merged client.
- **Anyone who can edit a client can invite its business owner**, and make them a new sign-in link. Before, only the account lead or an admin could. Removing the owner's login is still the account lead's or an admin's.
- **One word, one meaning.**
  - On the team, the person who holds a client is now the **Account lead**.
  - The business owner's side is **Business owner's app** (Edge Meta AI), not "Owner portal".

## Check after deploy

1. On a planned post the owner approved, the task on the client's board has a person on it. Move it to Done: the content calendar shows the post as Made.
2. Open one task in two tabs. Save in one, then save in the other: the second one says someone saved first and offers both choices.
3. Archive a test client that has a schedule: Schedules shows it paused. Unarchive: it runs again.
