# Ops endpoints — admin routes with no button, on purpose

Two admin endpoints have no control in the admin panel. That is deliberate, and this file is the
reason the wiring audit accepts them: an admin route with neither a control nor a mention here is
treated as a feature nobody can find, and fails `npm run audit`.

Both are called by hand, with an admin bearer token.

```bash
TOKEN=$(...)   # an admin session's access_token
B=https://leadgen-backend-1-mgzc.onrender.com
```

---

## `GET /api/admin/cost-reality`

**What it answers:** are the hardcoded Apify cost constants anywhere near what Apify actually
charged? Every estimate in the product — the run-cost line, the budget reservation, the trial's
dollar ceiling — is built on constants like `COST_PER_1K_PROFILE`. If the real cost has drifted, the
whole spend model is quietly wrong in one direction.

It reads settled `apify_usage_events` only. Reservation rows still carry the estimate, and
validating an estimate against itself always agrees.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$B/api/admin/cost-reality?days=90" | python -m json.tool
```

`days` defaults to 90, capped at 365.

**Why no button:** it is a calibration check, not an operation. Reading it monthly is enough, and a
dashboard tile implying it needs watching would be worse than the curl.

**What to do with the answer:** if an actor's real cost per 1,000 differs from the constant by more
than about 20%, change the constant in `server.js` and redeploy. The drift alarm covers runaway
spend; this covers slow, silent mispricing.

---

## `POST /api/admin/rotate-encryption-key`

**What it does:** re-encrypts every stored credential — Apify tokens, Meta page tokens, Meta user
tokens — from `ENC_KEY_OLD` to `ENC_KEY`. It touches every secret in the system.

**Restricted twice over:** admin role *and* the caller's email must equal `MASTER_ADMIN_EMAIL`. If
that env var is unset, nobody can run it at all.

Dry run first. It is a dry run unless `confirm` is exactly `"rotate"`:

```bash
# 1. dry run — reports what WOULD change, writes nothing
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{}' "$B/api/admin/rotate-encryption-key" | python -m json.tool

# 2. for real
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"confirm":"rotate"}' "$B/api/admin/rotate-encryption-key" | python -m json.tool
```

**Procedure:**

1. Set `ENC_KEY_OLD` to the current key and `ENC_KEY` to the new one. Deploy. `/api/health` will
   report `rotationPending: true` — the server now decrypts with either key and encrypts with the new.
2. Dry run. Check the counts match what you expect.
3. Run it for real.
4. Remove `ENC_KEY_OLD`. Deploy. `rotationPending` returns to `false`.

**Why no button:** a single mis-click re-encrypts every credential in the product. The two-step
confirm, the master-admin check and the deliberate awkwardness of curl are the safety, and a button
would undo all three. This is the one place where being harder to do is the feature.
