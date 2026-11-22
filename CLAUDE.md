# CLAUDE.md

## Database

The production database is the Supabase project **`sasbwgollyjpwegsbrty`**:

```
SUPABASE_URL=https://sasbwgollyjpwegsbrty.supabase.co
```

- `src/01-core.js` connects with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; the
  frontend hardcodes the same URL in `frontend/header.js`, `frontend/index.html`
  and `frontend/signup.html`. The Render deploy's `SUPABASE_URL` is this same
  project.
- The schema lives in `sql/*.sql`, applied in phase order. The live database
  matches it through phase 69.
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

## Hosting

- Pages: Netlify project **edgeleadworkspace** (prantoyousuf97's team), serving
  `workspace.edgelead.online` and `ai.edgelead.online`. DNS for edgelead.online is on
  Cloudflare. The team runs on credits: every production deploy (each merge to main)
  uses some, so group changes into fewer merges.
- Server: Render, deploys from main.

## Setting up ads for a client

When the user says "let's set up ads here" (or asks for an ad plan or ad set), follow
`.claude/skills/ad-setup/SKILL.md`: work in the built-in browser on the client's
**Ad brief & plan** tab, look at their Page and Meta's Ad Library, research the season and
market, fill in the brief, and save a **draft** plan. The user signs in themself; nothing
is ever changed in Meta, and the plan is approved by a person.
