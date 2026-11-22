# Phase 86 — reloading Edge Meta AI without zoom

An app opened from the home screen has no browser bar, so it has no reload button, and on an iPhone it has no pull-to-refresh either. Phase 80 rightly turned zooming off. Together, that left the owner no way to get a new version short of closing the app.

## Run

Nothing to run: no SQL, no server change. Merge, and Netlify deploys the pages.

**Netlify must publish the deploy.** Every production deploy from #54 to #58 shows "Skipped" on Netlify ("a new one was scheduled for the same branch"), so ai.edgelead.online is still on Phase 80. Log in to Netlify, open edgeleadwork → Deploys, and trigger a production deploy of `main`. After it publishes, the address serves `el-shell-v11` (check at https://ai.edgelead.online/sw.js).

## What changed

Three ways to get the newest version, none of which brings zooming back:

- **Account menu → Reload the app.** It asks the service worker to look for a new version, then reloads.
- **Pull the chat down from its top, on a phone.** A small label says "Pull down to reload", then "Release to reload". A short pull does nothing.
- **A bar: "A new version of Edge Meta AI is ready. Reload."**
  - The page notes the versions of itself and its main files (`ai/`, `meta-ai.js`, `owner-hub.js`, `meta-ai.css`, `ai/i18n-bn.js`) when it opens.
  - It checks them again whenever the app comes back to the front, and every 30 minutes, skipping every cache. If any has changed, the bar appears.

Also:
- Help → The app → **Getting the newest version**.
- All of it is in Bangla too.
- The service worker is now `el-shell-v11`, and the language files are at `?v=3`.

## Check after deploy

1. On the phone, open Edge Meta AI from the home screen.
2. Account menu → **Reload the app**: the app reloads.
3. At the top of the chat, pull down past the label and let go: the app reloads.
4. Pinch the screen: it does not zoom.
5. After the next deploy, switch away from the app and back: the **Reload** bar appears.
