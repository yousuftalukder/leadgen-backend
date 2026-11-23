# Phase 88: the Phone, and jobs won on the Overview

Order: SQL, then the server, then the pages.

## 1. Run the SQL (Supabase → SQL editor)

Run `sql/schema-phase88.sql`. It is safe to run twice. It adds `phone_calls`, `phone_messages` and `phone_contacts`, the `service` column on `crm_leads`, and the `sms` activity type.

## 2. Twilio, once (console.twilio.com)

1. **Account SID and Auth Token:** on the console home page.
2. **API key:** Account → API keys & tokens → Create API key (Standard). Copy the SID (`SK…`) and the secret. The secret is only shown once.
3. **TwiML App:** Voice → Manage → TwiML apps → Create.
   - Voice request URL: `https://leadgen-backend-1-mgzc.onrender.com/api/phone/hook/voice` (HTTP POST).
   - Copy its SID (`AP…`).
4. **The number (469) 819-4097:** Phone Numbers → Manage → Active numbers → the number.
   - Voice → A call comes in: Webhook, the same URL as the TwiML App, HTTP POST.
   - Optional: Call status changes: `…/api/phone/hook/status`.
   - Messaging → A message comes in: `https://leadgen-backend-1-mgzc.onrender.com/api/phone/hook/sms` (after 10DLC).

Admin → Phone in the CRM shows both addresses, with Copy buttons.

## 3. Render → the backend service → Environment

| Name | Value |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_AUTH_TOKEN` | the auth token |
| `TWILIO_API_KEY` | `SK…` |
| `TWILIO_API_SECRET` | the API key's secret |
| `TWILIO_TWIML_APP_SID` | `AP…` |
| `PHONE_NUMBER` | `+14698194097` (the default) |
| `PHONE_VOICEMAIL_EMAIL` | `info@edgehometx.com` (the default) |
| `PHONE_FORWARD_TO` | optional: a mobile to try for 20 s before voicemail |
| `PHONE_SMS_ENABLED` | `1` only once A2P 10DLC is approved |
| `PHONE_RECORD` | `1` to record answered calls (callers hear "This call may be recorded") |

Every webhook is checked against Twilio's signature, made with the auth token over `https://leadgen-backend-1-mgzc.onrender.com/...`. If the server ever moves, set `PHONE_PUBLIC_URL` to its new address.

Voicemail emails use the workspace's existing mail settings.

## How it behaves

- **Open hours, Mon–Sat 8 AM–6 PM Central:** an incoming call rings every teammate who has the CRM or the Phone app open.
  - No answer within 20 s: it goes to `PHONE_FORWARD_TO`, if set.
  - Still no answer: the greeting and voicemail play. The voicemail is transcribed, emailed, and shown in the Phone.
- **After hours:** the greeting and voicemail play straight away.
- **Missed calls:** once texting is on, the caller gets one automatic text per day: "Sorry we missed you…".
- **Outgoing calls:** they show (469) 819-4097.
- **Leads:** calls and texts with a lead's number appear on that lead's timeline.
- **STOP and HELP:** Twilio answers these itself (Advanced Opt-Out). The Phone remembers a STOP and won't text that number again until it replies START.
- **The desktop app:** `phone.html` is the Phone on its own and installs as "EdgeLead Phone". Use the ⋯ menu in the Phone → Install as a desktop app.
- **When calls ring:** only while the CRM or the Phone app is open. Otherwise they forward or go to voicemail.

## Overview: jobs won

Converting a lead now records the service sold. The Overview adds up won jobs by type (Websites, SEO, Marketing & ads, Influencer campaigns), with revenue for the period and for all time. Leads won before this phase are counted by the department of their source.
