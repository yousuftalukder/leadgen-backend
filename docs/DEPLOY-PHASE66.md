# Phase 66 — publish to the public website

## Run

There's no SQL. Do these in order:

1. **Create a GitHub token for the website repository.** GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   - **Repository access:** only `yousuftalukder/Edge-lead-Front-end`.
   - **Permissions:** Contents: Read and write. Commit statuses: Read-only. Checks: Read-only. (Metadata: Read-only is added automatically.)
   - **Expiry:** the longest you are comfortable with. When it expires, publishing stops with a "GitHub refused the website token" message until it is replaced.
2. **Set these on Render** (the backend service → Environment):
   - `SITE_REPO_TOKEN` — the token from step 1.
   - `SITE_PUBLIC_URL` — the website's address, e.g. `https://edgeleadweb.netlify.app` (later the real domain). Used for "Open the site" and image previews.
   - Optional: `SITE_REPO` (default `yousuftalukder/Edge-lead-Front-end`) and `SITE_BRANCH` (default `main`).
3. **Deploy the server on Render,** then the pages on Netlify.
4. **Netlify already builds `Edge-lead-Front-end`** (site edgeleadweb). With its GitHub app connected, Netlify then reports each build back on the commit, and the page shows Building… → Live, or Build failed with a link to the log.

## What changed

- **A new admin page, Our website** (`site.html`, under Admin in the menu). It has five tabs:
  - **Work & proof:** websites, campaigns and products. Each has a cover photo, up to four results, the service pages it shows on, and optionally the live-site viewer with its screenshots.
  - **Blog:** articles in Markdown, with a cover and images placed in the text. A draft is saved without showing on the site.
  - **Pricing & plans:** each service's price (or "on request" line), its card lines, and its plan table.
  - **Results:** the figures on each service page, the homepage stat, and the Edge Meta AI answers. Each one says when it was entered. A tick marks figures that are still examples.
  - **Site settings:** the master price switch, contact details, and the homepage ticker.
- **Every Publish is one commit** to the website repository. Netlify rebuilds in about a minute, and the site shows that content until the next change. Nothing on the site syncs live.
- **Nothing is overwritten by accident.** If someone else published the same item since you opened it, your save is refused and the page reloads their version. A save that races another publish is rebuilt on top of it once.
- **Images are shrunk in the browser** (JPEG, at most 1.3 MB), uploaded one at a time, and committed with the item they belong to. When an item stops using an image, or is removed, its images are deleted in the same commit.
- **The server checks every field against the website's own rules** before committing. A mistake comes back as a message on the page instead of a failed website build.
- **The server's runtime part moves** from `src/22-runtime.js` to `src/23-runtime.js`, so its catch-all 404 stays after the new routes in `src/22-website.js`.
- **New routes**, all admin-only:
  - `GET /api/site/content`, `GET /api/site/status`
  - `POST /api/site/images`
  - `PUT|DELETE /api/site/work/:id`, `PUT|DELETE /api/site/blog/:id`
  - `PUT /api/site/services/:id`, `PUT /api/site/settings`

## Check after deploy

- Open **Our website**. The tabs list the site's current work, articles and services. If it says "Publishing is not set up yet", `SITE_REPO_TOKEN` is missing.
- Edit one ticker line under **Site settings** and press **Publish**.
  - A commit `content: update site settings…` appears in `Edge-lead-Front-end`.
  - Within about a minute, the status shows **Live** and the homepage shows the line.
- Replace the example figures under **Results** with real ones, untick "still example figures", and publish. The yellow banner goes away when none are left.
