# CLAUDE.md

## Database

The production database is the Supabase project **`sasbwgollyjpwegsbrty`**:

```
SUPABASE_URL=https://sasbwgollyjpwegsbrty.supabase.co
```

- `src/01-core.js` connects with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; the
  frontend hardcodes the same URL, the anon key and the Render backend URL in
  `frontend/app/app.js` (the CRM) and `frontend/app/tools.js` (the Tools). The Render
  deploy's `SUPABASE_URL` is this same project.
- The schema lives in `sql/*.sql`, applied in phase order. Phase 90's SQL may not have run yet: the server checks
  (`S.p90Ready()`) and keeps working without it.
- **Do not use `rxrgrrxwxkqiclwbvock`.** That is a different Supabase project
  (the one the Claude Supabase connector may point at) and is unrelated to this
  app.
- In cloud sessions the key is supplied as an environment API credential. The key
  is the service role, so any write hits production data — read only unless
  asked to change something.
- The credential reaches the REST API only, which cannot run DDL. A new
  `sql/schema-phaseN.sql` is applied by the owner in the Supabase SQL editor,
  before the server that needs it deploys (order: SQL → server → pages).

## Working on it

- The server is `server.js` plus its parts in `src/` (phase 55), loaded in
  numbered order. They share one namespace, `src/shared.js` (`S`): a part
  unpacks what it needs from earlier parts at its top and reads anything from
  a later part as `S.name` when it runs. A new top-level name used by another
  part must be added to `S` where it is defined: a function in the
  `Object.assign(S, …)` at the top of its part, a `const` with `S.name = name;`
  straight after its declaration (it does not exist yet at the top).

- `npm run check` and `npm test` before every push; CI runs the same on every PR.
- Each phase gets a `docs/DEPLOY-PHASEN.md` saying what to run and what changed.

## The pages (phase 89)

- `frontend/` holds two apps and nothing else old:
  - **The CRM** at `/`: `index.html` with `app/app.js` (shell, Overview, Leads with its map, Pipeline, Clients list,
    the lead record, Influencers, Phone). The client page (`app/client.js`), email campaigns (`app/campaigns.js`)
    and Admin (`app/admin.js`) load the first time they open, through the small `window.CRM` interface.
  - **The lead flow (phase 90):** Leads holds every lead (cold or not) with an industry and a category (its source).
    A lead is put in the pipeline on purpose (`in_pipeline`); email, calls and texts are worked from there. Won →
    Convert to client → the client page. Campaign sending is `src/25-campaigns.js`; settings, today, history and the
    map are `src/25-crm-plus.js`.
  - **The Tools** at `/tools`: `tools/index.html` with `app/tools.js`. These are the Apify work (Lead Finder,
    Instagram report, Facebook Page report, Facebook groups), kept out of the CRM.
  - **The Phone** at `phone.html` (and `#phone` in the CRM), `app/phone.js`: Dialer, Inbox and Settings tabs
    (phase 91). The dialer's queue, call outcomes, phone access and hours, and the call lists are `src/25-dialer.js`;
    the owner sets them in Admin → Phone and Admin → Dialer. The server checks phone access on every call, text,
    outcome and ring; the page only reflects it. The installed app asks for the workspace password when it opens.
  - The three legal pages Meta reviews.
  - Both apps share `app/app.css`. Never send anyone to `crm.html`: it and every old page address move to `/`.
- **Who opens the Tools:** the person must be given the tool in Admin → Tools (their engine grants, plus the
  clients they may run it for) and the tool must be unlocked (`tools_enabled`). The server checks both;
  the button only reflects them.
- `frontend/phone-codes.js` is not a page: the server requires it.

## Hosting

- Pages: Netlify project **edgeleadworkspace** (prantoyousuf97's team), serving
  `workspace.edgelead.online` and `ai.edgelead.online`. DNS for edgelead.online is on
  Cloudflare. The team runs on credits: every production deploy (each merge to main)
  uses some, so group changes into fewer merges.
- Server: Render, deploys from main.

## Setting up ads for a client

When the user says "let's set up ads here" (or asks for an ad plan or ad set), follow
`.claude/skills/ad-setup/SKILL.md`. The client page with the **Ad brief & plan** tab was removed in
phase 89; its API (`/api/clients/:id/ad-brief`, `/ad-plans`) still works, but there is no page for it until
one is rebuilt. Until then, tell the user before starting. The skill's steps: work in the built-in browser on the client's
**Ad brief & plan** tab, look at their Page and Meta's Ad Library, research the season and
market, fill in the brief, and save a **draft** plan. The user signs in themself; nothing
is ever changed in Meta, and the plan is approved by a person.
