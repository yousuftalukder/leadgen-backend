# Deploy — phase 28

The Render link serves the front end; every push is tested; the content plan is walked; and the
list of what is left, by owner.

**No SQL.** Server: one addition (static serving). Pages: none. Repo: CI.

## What changed

| Area | Now |
|---|---|
| **Render serves the front end** | `express.static('frontend')` from the API process, with the same must-revalidate caching as `netlify.toml`. The brief asked for the front end in the repo *and* reachable from the Render link; the Render root answered 404 for every page until now. The folder is still named `frontend` — Netlify's config points at it and nothing gains from a rename. Both origins serve the same files; the pages call the same backend either way. |
| **CI** | `.github/workflows/test.yml` — every push and pull request runs the syntax check, `npm test` and `npm run audit`. No `npm ci`: the tests stub every external module, so a green run proves the code, not the lockfile. Until this existed, a broken push went live and the tests ran when someone remembered. |
| **Content plan walked** | `tests/usecases.test.js` seeds stored posts for a target and a rival, starts a real plan (zero credit), and answers the model's prompt *as a function of the scorecard the server built* — claiming "worth boosting" on every cell it was offered plus one it invented. The run must downgrade every gap cell, keep every proven one, strip the model's spending rationale from the downgrade, and drop the invention. It does. E12 moves from UNIT to E2E. |
| **`docs/GO-LIVE.md`** | What is left to 100%, by owner, with a time on each. Mirrored in the model doc. |

## Post-deploy checks

1. Open the Render URL's root in a browser: the sign-in page, styled. `/app.css` returns CSS with
   `Cache-Control: public, max-age=0, must-revalidate`.
2. The GitHub Actions run for this commit is green.
3. `npm test` — 335 checks across 11 files, 95 walked flows; `npm run audit` — 38.

## Known limits

- **Two origins, one Supabase auth config.** Email-confirmation links from sign-up go to whichever
  Site URL Supabase holds (Netlify today). Sign-in works from either origin; only the confirmation
  redirect is single-origin.
- **`ALLOWED_ORIGINS` is unchanged.** Pages served from Render call the backend same-origin, which
  needs no CORS entry. Netlify's origin stays listed.
