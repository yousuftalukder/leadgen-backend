# Phase 63 — Edge Meta AI in the site's look

## Run

There's no SQL change and no server change. Deploy the pages on Netlify only.

## What changed

Edge Meta AI (`frontend/ai/`, the business owner's app) now has the same look the workspace took in phase 62:

- **Colours:** black, white hairlines, blue for sending and for the owner's own messages, and lime for "AI".
- **Type:** the name, the welcome heading and the suggested questions are in uppercase Space Grotesk. The chat itself is in Inter.
- **Controls:** the composer, the menus and the sign-in screen use the same 6–10 px corners as the workspace.
- **Install colours:** the app's theme and background colours (in the manifest and meta tags) are black, so an installed app's status bar and splash screen match. This applies to the workspace's manifest too.
- **Icon:** the app's icon is unchanged.

## Check after deploy

- Open `/ai/` while signed out. The sign-in screen reads "EDGE META AI", with "AI" in lime and a blue button.
- Sign in as an owner. Check the chat screen and the suggested questions on a phone and on a laptop. Send a question: your message shows in blue.
- On a phone that already has the app installed, the old splash colour can stay until the app is reinstalled.
