# Phase 75 — Edge Meta AI laid out like the Owner Assistant

## Run

Nothing to run: no SQL, no server change. The pages deploy on Netlify by themselves on merge.

## What changed

- **The left bar is the owner's whole app**, as in the Owner Assistant, from top to bottom:
  - Edge Meta AI and the business's name.
  - **To-dos** to tick off right there, with what is due or overdue. "See all" appears past five.
  - **Reports**, folding open to the latest eight, with **New check-up** under them.
  - Posts to approve, Working on, Daily numbers, the shared tools and Billing, each with its count.
  - New chat and Recent chats.
  - The account at the bottom: name and business, **Add to Home Screen** and **Sign out**.
- **Gone:** the row of buttons above the chat and the ⋯ menu. Everything in them is in the bar.
- **Which sections are open** (To-dos, Reports) is remembered on the device.
- **On a computer** the bar can be put away with the button at its top and brought back from the app bar. That is remembered on the device too.
- **On a phone** the bar slides over the chat from the button at the top left. That button shows how many to-dos and posts wait on the owner. Choosing a chat, a to-do or a report closes the bar. Touch targets are larger.
- **Add to Home Screen** uses the browser's own prompt where there is one (Chrome, Edge, Android). On an iPhone it shows the three Safari taps. It is hidden when the app is already opened from the home screen.

## Check after deploy

1. Open https://ai.edgelead.online on a computer. The bar shows To-dos, Reports and the rest. Tick a to-do and it is marked done, and the agency sees it.
2. Put the bar away and bring it back.
3. On a phone, open the bar from the top-left button, choose a report, and it opens. Account → Add to Home Screen.
