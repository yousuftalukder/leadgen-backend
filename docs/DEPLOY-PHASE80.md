# Phase 80 — Edge Meta AI: no zoom, the phone layout, Help, speaking a question

## Run

Nothing to run: no SQL, no server change. The pages deploy on Netlify by themselves on merge.

## Why

The Owner Assistant does these and Edge Meta AI did not. This is the first of four parts; the others are the light theme, the owner's profile, and English + Bangla.

## What changed

- **No zoom on a phone or tablet,** in the browser or the installed app:
  - The viewport sets `maximum-scale=1, user-scalable=no`; computers ignore this and still zoom.
  - Double-tap zoom is off, and so is the grey flash on a tap.
  - Text fields stay at 16 px on a phone, so an iPhone does not zoom in when one is tapped.
- **A phone always gets the phone layout.** A touch screen whose short side is under 600 px is marked as a phone, and the bar becomes the slide-over drawer. That holds when the browser asks for the "Desktop site" or the phone is turned sideways.
- **Speaking a question:** a microphone button sits beside Send.
  - It uses the browser's own speech recognition (Chrome, Edge, Android, Safari on iPhone).
  - The words go into the box as they are heard, never straight to an answer; the owner checks them and sends.
  - While it listens, it turns red and breathes, and the line under the box says how to stop.
  - A blocked microphone, no microphone, nothing heard, or no connection each say what to do.
  - Where the browser has no speech recognition (Firefox), the button is not shown.
  - It listens in Bangla once the app can be set to Bangla.
- **Help** in the account menu explains how the app works:
  - asking questions, with examples, and speaking them;
  - the bar: Overview, To-dos, Reports, Posts to approve;
  - how the numbers update, and that nothing is ever posted;
  - Add to Home Screen, signing in with a code, and who to ask when something is wrong.

## Check after deploy

1. On a phone, open https://ai.edgelead.online: pinching does not zoom, and the bar is the drawer even in "Desktop site".
2. Tap the microphone, allow it, and speak. The words appear in the box; tap again, then Send.
3. Account menu → **Help**.
