# Phase 64 — the server stays awake

## Run

There's no SQL and no page change. Deploy the server on Render. There's nothing to set.

## What changed

- **The server pings itself every four minutes, always.** The request goes to its own public `/api/health` URL. Render's free tier puts a service to sleep after about fifteen minutes without incoming traffic, so this stops the sleep.
  - **Before:** the server pinged only while a job was running, so the first visit after a quiet spell waited 10–15 s.
  - **Now:** the server never goes idle.
- **The URL is hard-coded,** so no setting is needed: `https://leadgen-backend-1-mgzc.onrender.com`. `SELF_URL` or Render's own `RENDER_EXTERNAL_URL` override it if set.
- **It only pings when running on Render,** where Render sets `RENDER`. A laptop or the test suite never pings production.
- **The startup log line `keepalive_on`** shows the URL being pinged.

## What it costs

- **Free hours:** running 24/7 uses about 744 of a free workspace's 750 instance-hours a month. Another free service in the same workspace shares that allowance and can run it out before the month ends.
- **Restarts still happen:** a deploy still restarts the server and interrupts running jobs. They resume, as before.
- **When it isn't needed:** on a paid Render instance the ping is harmless and does nothing useful.

## Check after deploy

- In the Render logs, the first boot shows `keepalive_on`.
- Leave the app alone for 30 minutes, then open it. It loads without the "Waking the server" notice.
