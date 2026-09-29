# CLAUDE.md

## Database

The production database is the Supabase project **`sasbwgollyjpwegsbrty`**:

```
SUPABASE_URL=https://sasbwgollyjpwegsbrty.supabase.co
```

- `server.js` connects with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; the
  frontend hardcodes the same URL in `frontend/header.js`, `frontend/index.html`
  and `frontend/signup.html`. The Render deploy's `SUPABASE_URL` is this same
  project.
- The schema lives in `sql/*.sql`, applied in phase order. The live database
  matches it through phase 31.
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

- `npm run check` and `npm test` before every push; CI runs the same on every PR.
- Each phase gets a `docs/DEPLOY-PHASEN.md` saying what to run and what changed.
