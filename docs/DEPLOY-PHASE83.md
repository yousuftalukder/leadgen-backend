# Phase 83 — Edge Meta AI in English or বাংলা

## Run

Nothing to run: no SQL. Merge, and Render (the server) and Netlify (the pages) deploy by themselves.

## What changed

- **A language switch in the account menu.** It names the other language in that language's own script: "বাংলা" in English, "English" in Bangla. This follows the Owner Assistant.
  - The choice is kept on the device (`ema_lang`).
  - If no choice has been made, a browser set to Bangla starts in Bangla.
  - Switching to Bangla shows at once. Switching back to English reloads the page.
- **The app's own words are in Bangla:** sign in, the bar, the account menu, the chat, its errors and the voice messages, the figure labels, every sheet, and the fixed follow-up questions. That covers Overview, To-dos, Posts, Reports and the check-up, Daily numbers, Billing and the agreement, Profile and Help.
  - Short dates are in Bangla too ("২৫ অক্টো").
  - What people wrote stays as written: questions, chat titles, names, and the agency's to-dos and posts.
  - How it works: `frontend/ai/i18n.js` replaces each English phrase with its Bangla as the page draws it, from `frontend/ai/i18n-bn.js`, as the Owner Assistant does. A phrase that is not in the dictionary stays in English.
- **Answers come in Bangla:**
  - The chat sends `lang` with each question.
  - With `bn`, `xp/ai/chat.js` adds a LANGUAGE rule to the instructions: write the whole answer in Bangla, and keep names, platform names and every figure as the tools give them.
  - Any other value adds nothing, so English answers are unchanged.
- **Speaking a question** (phase 80) listens in Bangla (`bn-BD`) when the app is in Bangla.
- The service worker keeps the two language files for when the connection is weak (`el-shell-v9`).

## Not covered

- Follow-up questions built from the figures, such as "What drove the 12% drop on Instagram?", stay in English.
- Reports, invoices and the Find customers and Local demand tools inside a sheet stay in English. They come from the agency and the workspace.

## Check after deploy

1. https://ai.edgelead.online → account menu → **বাংলা**: the app turns Bangla.
2. Ask "এই মাসে কেমন চলছে?": the answer is in Bangla, with the same figures.
3. Open সারসংক্ষেপ (Overview) and সাহায্য (Help): both are in Bangla.
4. Account menu → **English**: the page reloads in English.
