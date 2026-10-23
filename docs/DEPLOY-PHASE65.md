# Phase 65 — connecting Facebook through Facebook Login for Business

## Run

There's no SQL and no page change. Deploy the server on Render.

## What changed

The EdgeLead Meta app is a Business app. Its login is **Facebook Login for Business**, which takes a *configuration id* instead of a list of permissions.

- **The connect button now opens Facebook's window with `config_id=1507223484577016`.** That is the "EdgeLead connect" configuration in App Dashboard → Facebook Login for Business → Configurations.
- **The configuration grants the same read-only permissions the code always asked for:**
  - Pages: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `read_insights`
  - Instagram: `instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`
  - Business and ads: `business_management`, `ads_read`
- **The id is not a secret, so it is the default in the code.**
  - `META_CONFIG_ID` on Render overrides it.
  - `META_CONFIG_ID=none` goes back to sending the permission list.
- **`/api/meta/status` also reports `configId`.**

If a permission is added to `META_SCOPES` later, add it to the configuration in the App Dashboard too. The configuration decides what Facebook grants.

## Set on Render (if not already)

- `META_APP_ID`: the App ID (App settings → Basic)
- `META_APP_SECRET`: the App Secret (App settings → Basic)
- `FRONTEND_URL`: the workspace's Netlify address

## Set in the Meta App Dashboard

- **Valid OAuth Redirect URIs:** under Facebook Login for Business → Settings, set `https://leadgen-backend-1-mgzc.onrender.com/api/meta/oauth/callback`.
- **Testers:** under App roles → Roles, add every person who will connect a Page while the app is unpublished.

## Check after deploy

1. As a Tester, go to Clients → a client → Connect Facebook.
2. Facebook's window lists the configuration's permissions. Tick the Page and its Instagram account.
3. You land back on Clients.
4. `select scopes from meta_connections order by created_at desc limit 1` lists the granted permissions.
