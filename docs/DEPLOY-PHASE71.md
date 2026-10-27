# Phase 71 — email through Resend

## Run

There's no SQL. Deploy the server on Render, and the pages on Netlify (which happens by itself on merge).

Then go to **Team & settings → Email** and do these steps:

1. **Paste your Resend API key** (resend.com → API Keys; it starts with `re_`).
2. **Leave *Send from* empty for now.** Resend then uses its test sender, `onboarding@resend.dev`. That sender only delivers to the email you signed up to Resend with.
3. **Press Send a test email.** It goes to the notification address, which is the Gmail address unless you set another one. It arrives if that is your Resend login email.
4. **To mail anyone else** (teammates, business owners):
   - add your domain at resend.com → Domains and add the DNS records it shows;
   - once it says Verified, set *Send from* to an address on it, such as `hello@yourdomain.com`;
   - save and test again.

## Why

On Render's free plan, outgoing SMTP is blocked, so the Gmail test ended in "Connection timeout". Nothing could go out: no task emails, no owner sign-in codes, no trial notices. Resend is sent over HTTPS, which isn't blocked.

## What changed

- **Choosing the route:** when a Resend API key is saved, every email goes through Resend's API. With no key, Gmail is used exactly as before.
- **Storing the key:** it is sealed like the Gmail app password and never sent back to a browser. The field says "saved".
- **Send from:**
  - Resend sends only from a domain verified with it, so *Send from* is its own field.
  - A Gmail, Yahoo or Outlook address is refused there, with the reason.
  - Empty means `onboarding@resend.dev`.
- **Replies** go to the Gmail address when one is saved.
- **Resend's refusals come back in plain words:**
  - an unverified domain says to verify it, and that the test sender reaches only your own address;
  - a bad key says to paste it again.
- **"Remove the Resend key"** goes back to Gmail.
- **The status line** says which route is in use, and from which address.
- **The test email** says whether it went through Resend or Gmail.

## Check after deploy

1. Save the key and press Send a test email. The line reads "Sent to …", and the message arrives.
2. Once the domain is verified and *Send from* is set: give a task to a teammate. They get "New task for you" within a minute.
