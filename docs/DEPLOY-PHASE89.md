# Phase 89: the old pages are gone, the CRM is at `/`, the Tools are at `/tools`

No SQL this time. Order: server, then pages.

## 1. Deploy the server (Render)

Merge to main. New routes:

| Route | Who | What |
| --- | --- | --- |
| `GET /api/tools/me` | team | The tools this person has, which are unlocked, and the clients they can run them for |
| `GET /api/tools/jobs` | team | Their last 30 Tools runs |
| `GET /api/admin/tools/access` | owner | The tool locks, and each teammate's tools and clients |
| `PUT /api/admin/tools/access/:id` | owner | Set a teammate's tools (`tools: ['leadfinder', 'reports', 'fbpage', 'fbgroups']`) and clients (`clients: [ids]`) |

`/api/crm/meta` also returns `me.tools`, so the CRM knows whether to show the Tools button and whether it is locked.

The tool gate now refuses business-owner logins on the three Apify tools (Lead Finder, reports, Facebook) with `403 tool_team_only`, even when a tool is unlocked. Edge Meta AI's own routes are unchanged.

`GET /api/admin/key-pools` is ops-only now: it was shown on the old Admin page. The new Admin shows each tool's key, the shared pool and the Gemini keys from `/api/apify-keys` and `/api/gemini-keys`. For the full "which key is used next, per person" breakdown, call `key-pools` directly.

## 2. Deploy the pages (Netlify)

Merging the same branch deploys them. One production deploy covers all of this.

## What changed for people

| Before | Now |
| --- | --- |
| `workspace.edgelead.online/crm.html` | `workspace.edgelead.online/`. `/crm.html` and every old page address move to `/` permanently (301) |
| About 35 old pages, closed but still in the repository | Deleted: `frontend/` holds the CRM, the Tools, the Phone and the three legal pages |
| `ai.edgelead.online` | Moves to `workspace.edgelead.online/` (301). Edge Meta AI's page was one of the old pages |
| Social tools switch in Admin | **Admin → Tools**: each tool's lock, and who has which tool for which clients |
| The old Apify key screen | **Admin → Apify and AI keys** |

### The Tools

- **What they are:** the Apify work. Lead Finder (Instagram, plus Facebook Pages), Instagram report, Facebook Page report, Facebook groups.
- **Where they live:** on their own page, `/tools`, outside the CRM. Nothing in the CRM changed how it works; "Add to CRM" in Lead Finder uses the same API as New lead.
- **Who sees the button:** the owner, and anyone given at least one tool. Nobody else sees a Tools button at all.
- **When it opens:** only when a tool the person has is unlocked. A locked button explains why, and `/tools` shows a locked screen.
- **Which runs a teammate can start:** only for the clients they are given in Admin → Tools. Every run is filed under a client.
- **Both locks are checked by the server on every call:** the tool switch (`tools_enabled`) and the person's engine grants (`user_engine_access`). Hiding a button is never the only lock.

Live state when this shipped: every tool locked (`tools_enabled = {}`). Dave has no tool grants. Nothing runs until the owner unlocks it.

### The CRM's look

- **Type:** one typeface (Inter) with even-width figures, replacing the serif headings and monospace numbers.
- **Navigation:** a dark navigation rail, and one accent colour for actions.
- **Tables:** quieter headers, underlined view tabs, and the same layout in light and dark.
- **Speed:** the map library (about 800 KB) loads the first time Influencers opens, not on every visit.

### Old installs

`sw.js` is now a worker that deletes the old caches, unregisters itself and reloads open tabs onto `/`. Phones that installed the old workspace app stop seeing the deleted pages. The Phone app keeps its own worker.

## If something is wrong

- **Bring a page back:** `git show 4aab000:frontend/<page>.html`. Every deleted file is in history.
- **Tools refusing someone:** open Admin → Tools. They need the tool ticked, at least one client ticked, and the tool unlocked.
